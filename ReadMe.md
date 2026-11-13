# Attention! Chrome Extension to Reduce Distractions 🚀

This Chrome extension is your productivity companion, designed to help you stay focused. With **Attention**, you can:

- **Declutter Social Media**: remove YouTube Shorts from the home and watch pages and Facebook Reels from the feed, and send you back to the home page when you open a Short or a Reel, each with its own on/off switch.
- **Block Distracting Websites**: block any site you choose, all day or on a schedule (e.g. 1 PM to 6 PM on Fridays and Saturdays). Blocked pages never load.
- **Give Yourself a Speed Bump**: set a PIN and a blocked page will offer to lift the block for 5 to 60 minutes. Forgot it? Reset it in Settings; it is a commitment device, not a lock.
- **See Where Your Attention Goes**: an Insights page shows how many Shorts, Reels and blocked visits were stopped, your temporary unblocks, your screen time on distracting sites and your focus streak, as cards and charts over 7, 30 or 90 days.
- **Bookmark YouTube**: save timestamps in a video and whole videos into playlists, and browse them on a dark-themed dashboard.

## Tech Stack

- Vanilla JavaScript (no build step)
- Manifest V3 (module service worker, `declarativeNetRequest`)
- HTML
- CSS

## Current Features

### Hide Shorts and Reels

- YouTube Shorts shelves (home and watch pages) and Facebook Reels sections are hidden the instant they appear (`hide.css`) and then removed from the page by the content script.
- Opening a Short (`youtube.com/shorts/...`) or a Reel (`facebook.com/reel/...`, the `facebook.com/reels` tab) sends you to the site's home page instead. Typed or shared links are redirected by `declarativeNetRequest` rules before the page loads. Opening one from inside the site (a click that only changes the URL, as both sites are single-page apps) is caught by the content script, which watches URL changes through the Navigation API. Only paths that *start* with `/shorts`, `/reel` or `/reels` are redirected: a channel's Shorts tab, watch pages and search results open normally, and a site blocked as a whole still ends on the blocked page.
- Each switch (Shorts, Reels) covers both the sections and the pages, and can be turned off on the Settings page. The switch applies to open tabs without a reload, including a tab already showing a Short.

### Block websites

- Add any site on the Settings page (typed as `reddit.com` or pasted as a full URL). Subdomains are blocked too; look-alikes such as `facebook.com.evil.com` are not.
- Per-site schedule: always, or a time range on chosen days of the week. Overnight ranges (22:00 to 06:00) work. Sites can be paused with a switch without losing their schedule.
- Blocking uses `declarativeNetRequest` redirect rules, so a blocked site is stopped before it loads: no flash of content. `background.js` recomputes the rules whenever the settings change and at every schedule boundary (via `chrome.alarms`), and redirects tabs already open on a site that just became blocked.
- The blocked page (`blocked.html`) names the site, explains the schedule in plain words ("Blocked from 1:00 PM to 6:00 PM on Fridays and Saturdays") and follows settings changes live.
- Nothing is blocked by default.

### Temporary unblock with a PIN

- With a PIN set, the blocked page offers to unblock the site for 5, 15, 30 or 60 minutes. The background worker checks the PIN, lifts the rule and re-blocks when the time is up.
- The PIN is a self-control aid, not security: it is stored as a plain SHA-256 digest and can be changed or removed on the Settings page without knowing it. Removing it also clears active temporary unblocks.

### Insights

- `insights.html` shows, for the last 7, 30 or 90 days:
  - **Cards**: estimated time saved, screen time, blocked visits, Shorts & Reels blocked, temporary unblocks (with minutes unblocked) and the focus streak (days in a row without a temporary unblock). Each card compares with the period before: green when the change is the healthy direction (less screen time, fewer unblocks), red when not, grey where neither is better.
  - **Charts**: screen time per day, Shorts vs Reels blocked per day, the top 5 blocked sites with their unblocks, and a 13-week screen time calendar. The daily charts and the calendar show each day's numbers on hover.
- What is counted:
  - *Shorts / Reels removed*: each Short or Reel inside a removed section (distinct `/shorts/<id>`, `/reel/<id>` links; a section removed before it filled in counts as one, so this is a lower bound).
  - *Shorts / Reels redirected*: each time a Shorts or Reels page sent you home.
  - *Blocked visits*: each attempt to open a blocked site. Reloading the blocked page, Back/Forward, and tabs the extension moved there itself (a schedule starting while the site was open) don't count.
  - *Temporary unblocks*: each unblock granted with a PIN, and its minutes.
  - *Time saved* is an **estimate**: 10 minutes per blocked visit, 5 per redirect, 1 per removed Short or Reel (`TIME_SAVED_MINUTES` in `statsStore.js`).
- The page updates live while open. Settings has a *Clear statistics* button (with a confirmation).
- Statistics stay on this device for 180 days and are never sent anywhere.

### Screen time

- Measured on YouTube, Facebook and every site on the block list (on those, it is the time spent during temporary unblocks or outside their schedule). The most specific match wins: a blocked `music.youtube.com` is counted apart from `youtube.com`.
- Time counts for the active tab of the last focused browser window while the screen isn't locked and either the window has focus and you aren't idle, or the tab is playing sound. `chrome.idle` only sees keyboard and mouse input, so without the sound exception a video would stop counting after the 2-minute idle threshold.
- `screenTime.js` (called by `background.js`) re-checks on tab, URL, focus, idle and sound changes, and once a minute while measuring. The interval being measured lives in `chrome.storage.session`, so a service worker restart loses nothing; quitting the browser loses at most about a minute. A single credit is capped at 2 minutes, so a computer that slept isn't counted as screen time.

### YouTube bookmarks

- Bookmark the current timestamp from a button in the player; the popup lists the timestamps of the video you are watching, with play and delete.
- Save the whole video to playlists from a "Save to…" panel in the player (works in fullscreen). *Favorites* and *Watch Later* always exist; custom playlists can be created, renamed and deleted.
- Dashboard pages: `videos.html` (recent and all bookmarked videos, playlists), `playlist.html` (one playlist) and `timestamps.html` (timestamps grouped per video) with thumbnails, channel names, pagination and undo for deletions. They update in real time when bookmarks change anywhere.

### Entry points

- Popup: your timestamps for the current video, a grid icon for the dashboard, a bar-chart icon for Insights and a gear icon for Settings.
- Every extension page has "Insights" and "Settings" links at the top right of its header; the bookmark tabs live on the bookmark pages.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings (sync) and bookmarks (local) |
| `tabs` | Notify the content script of YouTube navigations; redirect tabs already open on a newly blocked site; see which tracked site is on screen and whether it plays sound (screen time) |
| `alarms` | Wake the service worker at schedule boundaries, unblock expiries and once a minute while measuring screen time |
| `declarativeNetRequest` | Redirect blocked sites, and Shorts/Reels pages, before they load |
| `idle` | Stop counting screen time while you are away or the screen is locked |
| `<all_urls>` (host) | Required for redirect rules to apply to whichever sites the user blocks. Content scripts still run only on youtube.com and facebook.com |

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Module service worker: blocking and Shorts/Reels page rules, alarms, temporary-unblock and statistics messages, storage migration |
| `contentScript.js` | Runs on YouTube and Facebook: Shorts/Reels removal and page redirects, removal/redirect statistics, player bookmark buttons, "Save to…" panel |
| `hide.css`, `player-buttons.css` | Injected with the content script |
| `settingsStore.js` | Settings data and pure logic (domain normalization, schedules, rule building including the Shorts/Reels page rules, PIN, temporary unblocks) |
| `statsStore.js` | Usage statistics: per-day records, validation, aggregation for the Insights page (totals, daily series, top sites, focus streak, time-saved estimate) |
| `screenTime.js` | Screen time tracker used by the background worker |
| `bookmarkStore.js` | Bookmarked videos and playlists |
| `icons.js` | SVG icon registry shared by every surface |
| `popup.html/js/css` | Toolbar popup |
| `videos.html`, `playlist.html`, `timestamps.html`, `dashboard.js/css` | Bookmark dashboard |
| `settings.html/js/css` | Settings page |
| `insights.html/js/css` | Insights page |
| `charts.js` | Dependency-free SVG/HTML charts for the Insights page (stat cards, line, stacked bars, ranking, calendar heatmap) |
| `blocked.html/js/css` | Page shown for a blocked site |
| `utils.js` | Active-tab helper for the popup |
| `tests/unit`, `tests/e2e` | Vitest and Playwright suites |
| `scripts/package.sh` | Zips the extension for the Web Store |
| `scripts/test-package.sh` | Runs the e2e tests against the unpacked zip |

## Development

The extension is plain JavaScript, HTML and CSS loaded directly by Chrome, so **there is no build step**.
To run it locally open `chrome://extensions`, enable *Developer mode*, click *Load unpacked* and select this folder.

### Storage

- `chrome.storage.local` holds all bookmark data: bookmarked videos, playlists, video titles and one key per YouTube video id with its timestamp bookmarks. It is per device; video details are too large for the sync quota.
- `chrome.storage.sync` holds the extension settings (`settingsStore.js`): blocked sites with their schedules, the Shorts/Reels toggles and the unblock PIN hash. Temporary unblocks stay in `chrome.storage.local` so unblocking one device does not unblock the others.
- `chrome.storage.local` also holds the usage statistics (`statsStore.js`): one `attention_stats_day_<YYYY-MM-DD>` key per local day and `attention_stats_meta` (the first day tracked). Days older than 180 days are deleted. Only the background worker writes them; content scripts and pages report events with a `STATS_EVENT` message, so several tabs counting at once can't overwrite each other. Unblocks and screen time can only be recorded by the worker itself.
- `chrome.storage.session` holds the screen time interval being measured (`attention_screen_time_session`); it is cleared when the browser closes.
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
| `npm run test:package` | Builds the Web Store zip and runs the end-to-end tests against its unpacked contents |

The e2e tests never contact youtube.com or facebook.com. Requests to those hosts are answered with the static
pages in `tests/e2e/fixtures`, so the real content script, `hide.css` and background service worker run against a
deterministic DOM.

### Packaging for the Chrome Web Store

```bash
npm run package             # writes dist/attention-<version>.zip
```

This only zips the files the extension needs (no tests, configs or `node_modules`). The file list in
`scripts/package.sh` is kept by hand; `tests/unit/package.test.js` fails when a page, script or import is
missing from it, and `npm run test:package` runs the whole end-to-end suite against the built zip. Packaging is
optional; loading the folder unpacked is all that is required for development.

## Future Enhancements

- Preserve the full original URL through the block redirect, so "continue" after an unblock returns to the exact page.
- Busiest hours for blocked visits (hour-of-day heatmap) and an export of the statistics.
- LLM integration for summarizing content across pages.

Keep your focus sharp and distractions at bay with **Attention**! 🧠✨
