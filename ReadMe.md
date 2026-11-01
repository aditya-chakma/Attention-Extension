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
- Block websites to minimize distractions.  
- Bookmark YouTube video timestamps.  

## Development

The extension is plain JavaScript, HTML and CSS loaded directly by Chrome, so **there is no build step**.
To run it locally open `chrome://extensions`, enable *Developer mode*, click *Load unpacked* and select this folder.

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
