"""Stealth scraper for OrbytLink: a real, undetected Chromium (Patchright) behind two HTTP calls.

    POST /fetch  {url, waitFor?, timeoutSeconds?}      -> {status, finalUrl, html}
    POST /maps   {query, maxResults?, timeoutSeconds?} -> {query, places, partial}
    POST /session {url}  ·  POST /session/{id}/act {action, index?, text?, …}  ·  DELETE /session/{id}
                 a page OrbytLink's browser tool drives one action at a time -> {state}
    GET  /health

OrbytLink reads pages itself with plain requests first and sends a page here only when the site
blocks plain requests or needs JavaScript; Google Maps always comes here. It carries over Lead
Orbyt's approach: one warm browser reused across calls (a fresh context per call), the same Maps
selectors, and only public websites. Every request the browser makes, including redirects, images
and scripts, is checked: anything that resolves to a private or reserved address is aborted, so a
page can't use the browser to reach this server's own network.

Requires SCRAPER_TOKEN (the same value OrbytLink has). Bind it to a private network only.
"""
import asyncio
import hmac
import ipaddress
import os
import re
import secrets
import socket
import time
from urllib.parse import quote, urlparse

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="OrbytLink scraper", docs_url=None, redoc_url=None)
TOKEN = os.environ.get("SCRAPER_TOKEN", "")
# Chromium is heavy: a few pages at a time, the rest wait their turn.
SLOTS = asyncio.Semaphore(int(os.environ.get("SCRAPER_CONCURRENCY", "3")))
MAX_HTML = 2_000_000
USER_AGENT = os.environ.get(
    "SCRAPER_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
)
_browser = None
_playwright = None
_launch_lock = asyncio.Lock()


# ── Only public addresses ────────────────────────────────────────────────────
_resolved: dict[str, tuple[float, bool]] = {}


def _public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


async def public_host(host: str) -> bool:
    host = (host or "").strip("[]").lower()
    if not host or host == "localhost" or host.endswith(".localhost") or host.endswith(".internal"):
        return False
    try:
        ipaddress.ip_address(host)
        return _public_ip(host)
    except ValueError:
        pass
    cached = _resolved.get(host)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
        ok = bool(infos) and all(_public_ip(info[4][0]) for info in infos)
    except OSError:
        ok = False
    _resolved[host] = (time.monotonic() + 60, ok)
    if len(_resolved) > 5000:
        _resolved.clear()
    return ok


async def public_url(url: str) -> bool:
    u = urlparse(url)
    if u.scheme in ("data", "blob", "about"):
        return True
    return u.scheme in ("http", "https") and not u.username and not u.password and await public_host(u.hostname or "")


async def guard(route):
    request = route.request
    # Images, video and fonts add nothing to the text and slow every page down.
    if request.resource_type in ("image", "media", "font"):
        return await route.abort()
    if not await public_url(request.url):
        return await route.abort("addressunreachable")
    await route.continue_()


# ── The browser ──────────────────────────────────────────────────────────────
async def browser():
    global _browser, _playwright
    async with _launch_lock:
        if _browser is None or not _browser.is_connected():
            from patchright.async_api import async_playwright  # imported late so /health works without it

            if _playwright is None:
                _playwright = await async_playwright().start()
            _browser = await _playwright.chromium.launch(
                headless=True,
                args=["--disable-dev-shm-usage", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--no-first-run"],
            )
        return _browser


async def new_context():
    b = await browser()
    ctx = await b.new_context(user_agent=USER_AGENT, locale="en-US", service_workers="block", viewport={"width": 1366, "height": 900})
    await ctx.route("**/*", guard)
    return ctx


def authorize(authorization: str | None):
    if not TOKEN or not hmac.compare_digest(authorization or "", f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401, detail="unauthorized")


# ── One page ─────────────────────────────────────────────────────────────────
class Fetch(BaseModel):
    url: str = Field(max_length=2000)
    waitFor: str | None = Field(default=None, max_length=300)
    timeoutSeconds: int = Field(default=30, ge=5, le=60)


@app.post("/fetch")
async def fetch(req: Fetch, authorization: str | None = Header(default=None)):
    authorize(authorization)
    if urlparse(req.url).scheme not in ("http", "https") or not await public_url(req.url):
        raise HTTPException(status_code=400, detail="Only public http(s) pages can be read.")
    async with SLOTS:
        ctx = await new_context()
        try:
            page = await ctx.new_page()
            response = await page.goto(req.url, wait_until="domcontentloaded", timeout=req.timeoutSeconds * 1000)
            try:
                await page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            if req.waitFor:
                try:
                    await page.wait_for_selector(req.waitFor, timeout=5000)
                except Exception:
                    pass
            final = page.url
            if not await public_url(final):
                raise HTTPException(status_code=400, detail="The page redirected to a private address.")
            html = (await page.content())[:MAX_HTML]
            return {"status": response.status if response else 0, "finalUrl": final, "html": html}
        except HTTPException:
            raise
        except Exception as exc:  # timeouts, DNS failures, crashed pages
            raise HTTPException(status_code=502, detail=f"The page could not be loaded: {type(exc).__name__}")
        finally:
            await ctx.close()


# ── Google Maps ──────────────────────────────────────────────────────────────
# The selectors were confirmed by Lead Orbyt against live pages, not from any documentation. Google
# changes its markup without notice; if searches come back empty, these are the lines to fix.
FEED = 'div[role="feed"]'
RESULT_LINK = "a.hfpxzc"
COORDS = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")
COORDS_DATA = re.compile(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)")
PLACE_JS = """() => {
  const q = (s) => document.querySelector(s);
  const label = (s) => { const v = (q(s)?.getAttribute('aria-label') || '').trim(); return v.includes(':') ? v.split(':').slice(1).join(':').trim() : v; };
  const rating = q('div.F7nice span[aria-hidden="true"]')?.textContent?.trim() || '';
  const reviews = (q('div.F7nice span[aria-label*="review"]')?.getAttribute('aria-label') || '').replace(/[^0-9]/g, '');
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href);
  return {
    name: q('h1')?.textContent?.trim() || '',
    category: q('button[jsaction*="category"]')?.textContent?.trim() || '',
    website: q('a[data-item-id="authority"]')?.href || '',
    phone: label('button[data-item-id^="phone:tel:"]'),
    address: label('button[data-item-id="address"]'),
    plusCode: label('button[data-item-id="oloc"]') || label('button[data-item-id="plus_code"]'),
    rating, reviews,
    links: links.filter((h) => /mailto:|instagram\\.com|facebook\\.com|linkedin\\.com|twitter\\.com|x\\.com|youtube\\.com|tiktok\\.com/i.test(h)).slice(0, 30),
  };
}"""
SOCIAL = {
    "instagram": re.compile(r"(^|\.)instagram\.com$"),
    "facebook": re.compile(r"(^|\.)(facebook\.com|fb\.com)$"),
    "linkedin": re.compile(r"(^|\.)linkedin\.com$"),
    "x": re.compile(r"(^|\.)(twitter\.com|x\.com)$"),
    "youtube": re.compile(r"(^|\.)(youtube\.com|youtu\.be)$"),
    "tiktok": re.compile(r"(^|\.)tiktok\.com$"),
}


def coords(url: str):
    m = COORDS_DATA.search(url) or COORDS.search(url)
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)


def place_from(raw: dict, url: str) -> dict | None:
    if not raw.get("name"):
        return None
    lat, lon = coords(url)
    socials: dict[str, str] = {}
    email = ""
    for href in raw.get("links") or []:
        if href.lower().startswith("mailto:") and not email:
            email = href[7:].split("?")[0]
            continue
        host = (urlparse(href).hostname or "").lower()
        for platform, pattern in SOCIAL.items():
            if platform not in socials and pattern.search(host) and "google" not in host:
                socials[platform] = href
    website = raw.get("website") or ""
    # Maps sometimes wraps the website in a google.com/url redirect.
    if "google." in (urlparse(website).hostname or "") and "q=" in website:
        from urllib.parse import parse_qs

        website = (parse_qs(urlparse(website).query).get("q") or [""])[0]
    rating = raw.get("rating", "").replace(",", ".")
    return {
        "name": raw["name"],
        "category": raw.get("category", ""),
        "website": website,
        "phone": raw.get("phone", ""),
        "address": raw.get("address", ""),
        "plusCode": raw.get("plusCode", ""),
        "rating": float(rating) if re.fullmatch(r"\d+(\.\d+)?", rating) else None,
        "reviews": int(raw["reviews"]) if raw.get("reviews") else None,
        "email": email,
        "socials": socials,
        "mapsUrl": url,
        "lat": lat,
        "lon": lon,
    }


async def accept_consent(page):
    # Visitors from some regions first get Google's cookie consent page.
    if "consent." not in page.url:
        return
    for name in ("Reject all", "Accept all"):
        try:
            await page.get_by_role("button", name=name).first.click(timeout=3000)
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
            return
        except Exception:
            continue


class Maps(BaseModel):
    query: str = Field(min_length=2, max_length=300)
    maxResults: int = Field(default=20, ge=1, le=60)
    timeoutSeconds: int = Field(default=100, ge=20, le=110)


@app.post("/maps")
async def maps(req: Maps, authorization: str | None = Header(default=None)):
    authorize(authorization)
    deadline = time.monotonic() + req.timeoutSeconds
    async with SLOTS:
        ctx = await new_context()
        try:
            page = await ctx.new_page()
            await page.goto(f"https://www.google.com/maps/search/{quote(req.query)}?hl=en", wait_until="domcontentloaded", timeout=30000)
            await accept_consent(page)
            links: list[str] = []
            single = None
            try:
                await page.wait_for_selector(FEED, timeout=10000)
            except Exception:
                # A query that names one place opens that place directly instead of a list.
                if "/maps/place/" in page.url:
                    single = place_from(await page.evaluate(PLACE_JS), page.url)
            if single:
                return {"query": req.query, "places": [single], "partial": False}
            previous = -1
            for _ in range(30):
                count = await page.eval_on_selector_all(RESULT_LINK, "els => els.length")
                if count >= req.maxResults or count == previous or time.monotonic() > deadline - 30:
                    break
                previous = count
                await page.eval_on_selector(FEED, "el => el.scrollBy(0, el.scrollHeight)")
                await asyncio.sleep(1.5)
            links = (await page.eval_on_selector_all(RESULT_LINK, "els => els.map((a) => a.href)"))[: req.maxResults]
            await page.close()

            places: list[dict | None] = [None] * len(links)
            queue = list(enumerate(links))

            async def worker():
                tab = await ctx.new_page()
                try:
                    while queue and time.monotonic() < deadline - 3:
                        i, url = queue.pop(0)
                        try:
                            await tab.goto(url, wait_until="domcontentloaded", timeout=20000)
                            await tab.wait_for_selector("h1", timeout=8000)
                            await asyncio.sleep(0.6)
                            places[i] = place_from(await tab.evaluate(PLACE_JS), tab.url or url)
                        except Exception:
                            continue
                finally:
                    await tab.close()

            # Three tabs in one context: polite to Google, and about three times faster than one.
            await asyncio.gather(*(worker() for _ in range(min(3, len(links)))))
            found = [p for p in places if p]
            return {"query": req.query, "places": found, "partial": bool(queue)}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Google Maps could not be read: {type(exc).__name__}")
        finally:
            await ctx.close()


# ── Browser sessions ─────────────────────────────────────────────────────────
# OrbytLink's browser tool drives a page one action at a time: it reads the page here, asks one of its
# decision models which action and element come next, and sends that action back. This side only shows the page and
# carries out actions; it never decides anything. A session is one private context (the same request
# guard as above) and closes itself when idle.
STATE_JS = """(limit) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (v, n) => (v || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  document.querySelectorAll('[data-orbyt-i]').forEach((el) => el.removeAttribute('data-orbyt-i'));
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=switch], [contenteditable=true]';
  const all = [...document.querySelectorAll(sel)].filter(visible);
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const ordered = [...all.filter(inView), ...all.filter((el) => !inView(el))].slice(0, limit);
  const elements = ordered.map((el, i) => {
    el.setAttribute('data-orbyt-i', String(i));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const label = clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.querySelector('img')?.getAttribute('alt') || el.getAttribute('name') || (tag === 'a' ? el.getAttribute('href') : ''), 80);
    const out = { i, tag, label };
    const role = el.getAttribute('role'); if (role) out.role = role;
    if (type) out.type = type;
    if (tag === 'input' || tag === 'textarea') out.value = clean(type === 'password' ? '' : el.value, 60);
    if (tag === 'select') { out.value = clean(el.options[el.selectedIndex]?.text, 60); out.options = [...el.options].slice(0, 15).map((o) => clean(o.text, 40)); }
    if (el.checked) out.checked = true;
    if (el.isContentEditable) out.editable = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
    if (!inView(el)) out.offscreen = true;
    return out;
  });
  return { url: location.href, title: clean(document.title, 200), text: clean(document.body?.innerText, 8000), elements,
           scroll: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: innerHeight };
}"""
SESSIONS: dict[str, dict] = {}
SESSION_IDLE = 120
MAX_SESSIONS = int(os.environ.get("SCRAPER_SESSIONS", "3"))


class Open(BaseModel):
    url: str = Field(max_length=2000)
    timeoutSeconds: int = Field(default=30, ge=5, le=60)


class Act(BaseModel):
    action: str = Field(pattern="^(click|type|select|scroll|goto|back|wait)$")
    index: int | None = Field(default=None, ge=0, le=500)
    text: str | None = Field(default=None, max_length=2000)
    url: str | None = Field(default=None, max_length=2000)
    enter: bool = False
    direction: str | None = Field(default=None, pattern="^(up|down)$")


async def sweep():
    now = time.monotonic()
    for sid, s in list(SESSIONS.items()):
        if now - s["used"] > SESSION_IDLE:
            SESSIONS.pop(sid, None)
            try:
                await s["ctx"].close()
            except Exception:
                pass


async def settle(page):
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=8000)
        await page.wait_for_load_state("networkidle", timeout=3000)
    except Exception:
        pass


async def state_of(s: dict) -> dict:
    page = current(s)
    if not await public_url(page.url):
        raise HTTPException(status_code=400, detail="The page went to a private address.")
    return await page.evaluate(STATE_JS, 150)


def current(s: dict):
    open_pages = [p for p in s["pages"] if not p.is_closed()]
    if not open_pages:
        raise HTTPException(status_code=409, detail="The page was closed.")
    return open_pages[-1]


def session(sid: str) -> dict:
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(status_code=404, detail="That browser session has ended.")
    s["used"] = time.monotonic()
    return s


@app.post("/session")
async def open_session(req: Open, authorization: str | None = Header(default=None)):
    authorize(authorization)
    await sweep()
    if urlparse(req.url).scheme != "https" or not await public_url(req.url):
        raise HTTPException(status_code=400, detail="Only public https pages can be opened.")
    if len(SESSIONS) >= MAX_SESSIONS:
        raise HTTPException(status_code=429, detail="The browser is busy. Try again shortly.")
    ctx = await new_context()
    s = {"ctx": ctx, "pages": [], "used": time.monotonic(), "lock": asyncio.Lock()}
    # Links that open a new tab: follow the newest tab.
    ctx.on("page", lambda p: s["pages"].append(p))
    try:
        page = await ctx.new_page()
        await page.goto(req.url, wait_until="domcontentloaded", timeout=req.timeoutSeconds * 1000)
        await settle(page)
        sid = secrets.token_urlsafe(16)
        SESSIONS[sid] = s
        return {"id": sid, "state": await state_of(s)}
    except HTTPException:
        await ctx.close()
        raise
    except Exception as exc:
        await ctx.close()
        raise HTTPException(status_code=502, detail=f"The page could not be loaded: {type(exc).__name__}")


@app.post("/session/{sid}/act")
async def act(sid: str, req: Act, authorization: str | None = Header(default=None)):
    authorize(authorization)
    s = session(sid)
    async with s["lock"]:
        page = current(s)
        target = page.locator(f'[data-orbyt-i="{req.index}"]').first if req.index is not None else None
        error = None
        try:
            if req.action in ("click", "type", "select") and target is None:
                raise ValueError("this action needs an element index")
            if req.action == "click":
                await target.click(timeout=5000)
            elif req.action == "type":
                await target.fill(req.text or "", timeout=5000)
                if req.enter:
                    await target.press("Enter", timeout=5000)
            elif req.action == "select":
                try:
                    await target.select_option(label=req.text or "", timeout=5000)
                except Exception:
                    await target.select_option(value=req.text or "", timeout=5000)
            elif req.action == "scroll":
                await page.mouse.wheel(0, -700 if req.direction == "up" else 700)
                await asyncio.sleep(0.5)
            elif req.action == "goto":
                if not req.url or urlparse(req.url).scheme != "https" or not await public_url(req.url):
                    raise ValueError("only public https pages can be opened")
                await page.goto(req.url, wait_until="domcontentloaded", timeout=30000)
            elif req.action == "back":
                await page.go_back(timeout=10000)
            elif req.action == "wait":
                await asyncio.sleep(2)
        except Exception as exc:  # the element moved, a click was blocked, a page timed out
            error = str(exc).split("\n")[0][:200] or type(exc).__name__
        await settle(current(s))
        return {"ok": error is None, "error": error, "state": await state_of(s)}


@app.delete("/session/{sid}")
async def close_session(sid: str, authorization: str | None = Header(default=None)):
    authorize(authorization)
    s = SESSIONS.pop(sid, None)
    if s:
        try:
            await s["ctx"].close()
        except Exception:
            pass
    return {"ok": True}


@app.get("/health")
async def health():
    return {"ok": True}
