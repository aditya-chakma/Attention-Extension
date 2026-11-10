# Attention! Chrome Extension to Reduce Distractions 🚀  

This Chrome extension is your productivity companion, designed to help you stay focused. With **Attention**, you can:  

- **Bookmark YouTube Timelines**: Save specific timestamps in YouTube videos and revisit them directly from your bookmarks.  
- **Declutter Social Media**: Remove YouTube Shorts from the homepage and watch pages, and eliminate Facebook Reels from your newsfeed.  
- **Block Distracting Websites**: Prevent access to hardcoded sites that disrupt your workflow.  

Unlike traditional blockers, this extension works by **removing unnecessary elements** from the page, ensuring a seamless browsing experience.  

## Tech Stack

- Vanilla JavaScript  
- Manifest V3  
- HTML  
- CSS  

## Current Features

- Hide YouTube Shorts and Facebook Reels.  
- Block websites to minimize distractions. Blocking uses `declarativeNetRequest` redirect rules, so a blocked site is never loaded; schedules and temporary unblocks are applied by `background.js` recomputing the rules at each transition.  
- Bookmark YouTube video timestamps.  
- Bookmark whole videos at the current playback position (save button in the player).  
- Dark-themed dashboard (`videos.html`, `timestamps.html`) with thumbnails and channel names, kept in sync in real time, reachable from the popup.  

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

- Customization page for managing blocked sites and settings.  
- Fix for the bookmark button bug.  
- LLM integration for summarizing content across pages.  

Keep your focus sharp and distractions at bay with **Attention**! 🧠✨
