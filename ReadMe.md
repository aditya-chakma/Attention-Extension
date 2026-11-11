# Attention! Chrome Extension to Reduce Distractions 🚀

This Chrome extension is your productivity companion, designed to help you stay focused. With **Attention**, you can:

- **Declutter Social Media**: remove YouTube Shorts from the home and watch pages and Facebook Reels from the feed, each with its own on/off switch.
- **Block Distracting Websites**: block any site you choose, all day or on a schedule (e.g. 1 PM to 6 PM on Fridays and Saturdays). Blocked pages never load.
- **Give Yourself a Speed Bump**: set a PIN and a blocked page will offer to lift the block for 5 to 60 minutes. Forgot it? Reset it in Settings; it is a commitment device, not a lock.
- **Bookmark YouTube**: save timestamps in a video and whole videos into playlists, and browse them on a dark-themed dashboard.

## Tech Stack

- Vanilla JavaScript (no build step)
- Manifest V3 (module service worker, `declarativeNetRequest`)
- HTML
- CSS

## Current Features

### Hide Shorts and Reels

- YouTube Shorts shelves (home and watch pages) and Facebook Reels sections are hidden the instant they appear (`hide.css`) and then removed from the page by the content script.
- Each can be switched off on the Settings page. The switch applies to open tabs without a reload.

### Block websites

- Add any site on the Settings page (typed as `reddit.com` or pasted as a full URL). Subdomains are blocked too; look-alikes such as `facebook.com.evil.com` are not.
- Per-site schedule: always, or a time range on chosen days of the week. Overnight ranges (22:00 to 06:00) work. Sites can be paused with a switch without losing their schedule.
- Blocking uses `declarativeNetRequest` redirect rules, so a blocked site is stopped before it loads: no flash of content. `background.js` recomputes the rules whenever the settings change and at every schedule boundary (via `chrome.alarms`), and redirects tabs already open on a site that just became blocked.
- The blocked page (`blocked.html`) names the site, explains the schedule in plain words ("Blocked from 1:00 PM to 6:00 PM on Fridays and Saturdays") and follows settings changes live.
- Nothing is blocked by default.

### Temporary unblock with a PIN

- With a PIN set, the blocked page offers to unblock the site for 5, 15, 30 or 60 minutes. The background worker checks the PIN, lifts the rule and re-blocks when the time is up.
- The PIN is a self-control aid, not security: it is stored as a plain SHA-256 digest and can be changed or removed on the Settings page without knowing it. Removing it also clears active temporary unblocks.

### YouTube bookmarks

- Bookmark the current timestamp from a button in the player; the popup lists the timestamps of the video you are watching, with play and delete.
- Save the whole video to playlists from a "Save to…" panel in the player (works in fullscreen). *Favorites* and *Watch Later* always exist; custom playlists can be created, renamed and deleted.
- Dashboard pages: `videos.html` (recent and all bookmarked videos, playlists), `playlist.html` (one playlist) and `timestamps.html` (timestamps grouped per video) with thumbnails, channel names, pagination and undo for deletions. They update in real time when bookmarks change anywhere.

### Entry points

- Popup: your timestamps for the current video, a grid icon for the dashboard and a gear icon for Settings.
- Every extension page has a gear "Settings" link in its header next to the Attention brand; the bookmark tabs live on the bookmark pages.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings (sync) and bookmarks (local) |
| `tabs` | Notify the content script of YouTube navigations; redirect tabs already open on a newly blocked site |
| `alarms` | Wake the service worker at schedule boundaries and unblock expiries |
| `declarativeNetRequest` | Redirect blocked sites before they load |
| `<all_urls>` (host) | Required for redirect rules to apply to whichever sites the user blocks. Content scripts still run only on youtube.com and facebook.com |

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Module service worker: blocking rules, alarms, temporary-unblock messages, storage migration |
| `contentScript.js` | Runs on YouTube and Facebook: Shorts/Reels removal, player bookmark buttons, "Save to…" panel |
| `hide.css`, `player-buttons.css` | Injected with the content script |
| `settingsStore.js` | Settings data and pure logic (domain normalization, schedules, rule building, PIN, temporary unblocks) |
| `bookmarkStore.js` | Bookmarked videos and playlists |
| `icons.js` | SVG icon registry shared by every surface |
| `popup.html/js/css` | Toolbar popup |
| `videos.html`, `playlist.html`, `timestamps.html`, `dashboard.js/css` | Bookmark dashboard |
| `settings.html/js/css` | Settings page |
| `blocked.html/js/css` | Page shown for a blocked site |
| `utils.js` | Active-tab helper for the popup |
| `tests/unit`, `tests/e2e` | Vitest and Playwright suites |
| `scripts/package.sh` | Zips the extension for the Web Store |

## Development

The extension is plain JavaScript, HTML and CSS loaded directly by Chrome, so **there is no build step**.
To run it locally open `chrome://extensions`, enable *Developer mode*, click *Load unpacked* and select this folder.

### Storage

- `chrome.storage.local` holds all bookmark data: bookmarked videos, playlists, video titles and one key per YouTube video id with its timestamp bookmarks. It is per device; video details are too large for the sync quota.
- `chrome.storage.sync` holds the extension settings (`settingsStore.js`): blocked sites with their schedules, the Shorts/Reels toggles and the unblock PIN hash. Temporary unblocks stay in `chrome.storage.local` so unblocking one device does not unblock the others.
- Every reserved key starts with `attention_`; any other key is a video id. Versions before 1.2.0 kept bookmarks in sync storage, and `background.js` moves them to local storage once on install/update.

### Setup

```bash
npm install                 # test tooling only (Vitest, jsdom, Playwright)
npm run test:e2e:install    # one-time download of the Chromium build used by the e2e tests
```

### Running the tests

| Command | What it does |
|---|---|
| `npm test` | Runs the unit tests, then the end-to-end tests |
| `npm run test:unit` | Unit tests with [Vitest](https://vitest.dev) in a jsdom DOM and a mocked `chrome.*` API (`tests/unit`) |
| `npm run test:unit:watch` | Same, re-running on file changes |
| `npm run test:e2e` | End-to-end tests with [Playwright](https://playwright.dev): real Chromium with the unpacked extension loaded (`tests/e2e`) |
| `npm run test:e2e:headed` | Same, with a visible browser window |

The e2e tests never contact youtube.com or facebook.com. Requests to those hosts are answered with the static
pages in `tests/e2e/fixtures`, so the real content script, `hide.css` and background service worker run against a
deterministic DOM.

### Packaging for the Chrome Web Store

```bash
npm run package             # writes dist/attention-<version>.zip
```

This only zips the files the manifest needs (no tests, configs or `node_modules`). It is optional; loading the
folder unpacked is all that is required for development.

## Future Enhancements

- Preserve the full original URL through the block redirect, so "continue" after an unblock returns to the exact page.
- Usage statistics (time saved, blocks per day) on the dashboard.
- LLM integration for summarizing content across pages.

Keep your focus sharp and distractions at bay with **Attention**! 🧠✨
