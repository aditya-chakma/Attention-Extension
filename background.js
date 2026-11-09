// ---- Storage migration -----------------------------------------------------
// Bookmarks (video entries, playlists, titles and the per-video timestamp
// lists) used to live in chrome.storage.sync. They now live in
// chrome.storage.local: video details are far too large for the sync quota,
// and sync is reserved for the (small) extension settings. This runs once per
// device, on the first install/update that ships the change.

const MIGRATION_FLAG = "attention_migration_bookmarks_local";
const SETTINGS_PREFIX = "attention_";
const BOOKMARK_KEYS = ["attention_bookmarked_videos", "attention_playlists", "attention_video_titles"];

// Bare keys are YouTube video ids holding timestamp bookmarks; everything else
// under the prefix is a setting and stays in sync.
const isBookmarkKey = (key) => BOOKMARK_KEYS.includes(key) || !key.startsWith(SETTINGS_PREFIX);

async function migrateBookmarksToLocal() {
    const flags = await chrome.storage.local.get(MIGRATION_FLAG);
    if (flags[MIGRATION_FLAG]) return;

    const synced = await chrome.storage.sync.get(null);
    const local = await chrome.storage.local.get(null);

    const toMove = {};
    const toRemove = [];
    for (const [key, value] of Object.entries(synced)) {
        if (!isBookmarkKey(key)) continue;
        toRemove.push(key);
        // Data already saved locally on this device wins over the synced copy
        if (!(key in local)) toMove[key] = value;
    }

    // Write to local first; only once that succeeds is the synced copy dropped,
    // so a failure can't lose bookmarks (the migration just runs again)
    await chrome.storage.local.set({ ...toMove, [MIGRATION_FLAG]: true });
    if (toRemove.length > 0) await chrome.storage.sync.remove(toRemove);
}

chrome.runtime.onInstalled.addListener(() => {
    migrateBookmarksToLocal().catch((error) => console.error("Attention: bookmark migration failed", error));
});

// ---- Content script notifications -----------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // onUpdated fires several times per navigation (loading, title, favicon...);
    // only act on URL changes (SPA navigation) and the final load
    if (!changeInfo.url && changeInfo.status !== "complete") {
        return;
    }

    var properties = {};
    var allowedUrls = ["youtube.com", "facebook.com"];
    var tabUrl = "none";

    if (tab.url && tab.url.includes("youtube.com")) {
        tabUrl = "youtube.com";
        properties["url"] = tab.url;

        if (tab.url.includes("watch")) {
            properties["source"] = "yt-watch";
            properties["type"] = "NEW";

            const queryParameters = tab.url.split("?")[1];
            const urlParameters = new URLSearchParams(queryParameters);
            properties["videoId"] = urlParameters.get("v");
        } else {
            properties["source"] = "yt-home";
        }
    }

    if (tab.url && tab.url.includes("facebook.com")) {
        tabUrl = "facebook.com";
        properties["source"] = "fb";
        properties["url"] = tab.url;
    }

    if (allowedUrls.includes(tabUrl)) {
        // The content script may not be injected yet on first load; ignore that
        chrome.tabs.sendMessage(tabId, properties).catch(() => {});
    }
});
