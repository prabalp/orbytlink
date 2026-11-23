# OrbytLink: Your browser (Chrome extension)

Lets OrbytLink agents work in **your own Chrome profile**, with the sites you are already signed in to.
The server's browser stays as the fallback when no profile is connected.

## Install (per Chrome profile)

1. In OrbytLink open **Catalog → Scraper → Your browsers → Add my browser**. It shows a download link and a one-time code.
2. Unzip the download. In Chrome open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the folder.
3. Click the OrbytLink icon, type the code and a name for this profile (for example "Work"). Repeat in each profile you want to use.

The zip is built from this folder by `npm run extension` (it also runs before `npm run dev` and `npm run build`) and served at `/orbytlink-extension.zip`.

## How it works

- The extension only connects **outward**: it long-polls `/api/device/poll` on the OrbytLink server, does the work in a new window of this profile, and posts what the page looked like to `/api/device/result`. Nothing on your computer is reachable from outside.
- The server decides each next step with its decision models; the extension opens pages, clicks, types, selects and scrolls. It never types into a password field.
- Order of attempts for `orbytlink__browse` (`where: "auto"`): a connected profile first (`device` picks one by name), then the server's browser, which opens public pages only. `where: "local"` never falls back.

## What it asks you, and what it keeps

- **First time on a site:** a small window asks *Don't allow / Just this time / Always allow*. A redirect to another site asks again.
- **Buying, sending, posting, deleting** (a click whose label looks like one): asked every time, never remembered.
- **Stop:** a bar in the page says OrbytLink is working there; **Stop** ends the run.
- **Signing in:** when a page shows a password field, the window comes to the front and OrbytLink waits (up to 3 minutes) while you sign in. Two-factor codes and captchas are always yours.

## Private window and saved sign-ins (several profiles)

- **Use a private window for tasks** (panel setting) starts every run signed out in an incognito window. Chrome requires you to turn on **Allow in Incognito** for the extension in `chrome://extensions → OrbytLink → Details`.
- **Saved sign-ins** are kept on this computer only, encrypted with a passphrase you choose (AES-GCM, PBKDF2 with 310,000 rounds). They are never sent to OrbytLink. Once unlocked, the key lives in Chrome's memory-only session storage, so closing Chrome locks the vault. While waiting for you to sign in, OrbytLink fills and submits a saved login for that site, then waits for you to finish.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3; permissions `storage`, `scripting`, `tabs`, `alarms`, all sites |
| `background.js` | Pairing, poll loop, runs commands, approvals |
| `page.js` | Functions injected into pages: read the page, click, type, select, fill a login, the Stop bar |
| `vault.js` | The encrypted local vault |
| `panel.html/js`, `approve.html/js`, `style.css` | The toolbar panel and the approval window |

Tests: `tests/devices.test.ts` (server side), `tests/extension.test.ts` (page functions and the vault).
