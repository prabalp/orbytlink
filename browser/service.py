"""Browser sidecar for OrbytLink: runs Jev Ultrafast in headless Chrome behind one small HTTP call.

    POST /run   {url, goal, maxSteps, timeoutSeconds}  ->  {status, result, steps, finalUrl}
    GET  /health

Requires BROWSER_TOKEN (the same value OrbytLink has as BROWSER_TOKEN) and Jev's own keys
(TYPESAFE_API_KEY, TEXT_MODEL_API_KEY). Bind it to a private interface only; OrbytLink checks the
start page, and the token keeps everyone else out.
"""
import hmac
import os
import threading
import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="OrbytLink browser", docs_url=None, redoc_url=None)
TOKEN = os.environ.get("BROWSER_TOKEN", "")
# Chrome is heavy: a few runs at a time, the rest wait their turn (or are refused if too many wait).
SLOTS = threading.BoundedSemaphore(int(os.environ.get("BROWSER_CONCURRENCY", "2")))


class Run(BaseModel):
    url: str = Field(max_length=2000)
    goal: str = Field(min_length=3, max_length=4000)
    maxSteps: int = Field(default=15, ge=1, le=40)
    timeoutSeconds: int = Field(default=110, ge=5, le=300)


def last_text(state: dict) -> str:
    # Jev yields state dictionaries and has no fixed "final answer" field, so take the first
    # answer-like field present and fall back to the page's visible summary.
    for key in ("result", "answer", "final_answer", "output", "message", "summary"):
        if state.get(key):
            return str(state[key])
    return ""


def run_agent(req: Run) -> dict:
    from jev_ultrafast import Agent  # imported late so /health works without Jev installed

    started, steps, state = time.monotonic(), 0, {}
    with Agent(req.url, req.goal) as agent:
        for state in agent.run():
            steps += 1
            if steps >= req.maxSteps:
                break
            if time.monotonic() - started > req.timeoutSeconds:
                return dict(status="timeout", result=last_text(state), steps=steps, finalUrl=state.get("url"))
    status = str(state.get("status", "")).lower()
    # "DONE" is the agent's own claim, so OrbytLink hands it back as the agent's answer, not as proof.
    if steps >= req.maxSteps and status != "done":
        outcome = "timeout"
    else:
        outcome = "done" if status == "done" else "failed"
    return dict(status=outcome, result=last_text(state), steps=steps, finalUrl=state.get("url"))


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/run")
def run(req: Run, authorization: str = Header(default="")):
    if not TOKEN or not hmac.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(401, "Unauthorized")
    if not SLOTS.acquire(timeout=5):
        raise HTTPException(429, "The browser is busy. Try again shortly.")
    try:
        return run_agent(req)
    except Exception as error:  # never leak internals back to the caller
        print("browser run failed:", repr(error), flush=True)
        return dict(status="failed", result="The browser hit an error and could not finish.", steps=1, finalUrl=None)
    finally:
        SLOTS.release()
