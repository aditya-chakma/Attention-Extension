// The background worker is an ES module (see manifest.json) so it can share
// settingsStore.js with the extension pages and content scripts
import "./settingsStore.js";

const SETTINGS = globalThis.ATTENTION_SETTINGS;

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

// ---- Site blocking ---------------------------------------------------------
// Blocked sites are enforced with declarativeNetRequest dynamic rules, so a
// blocked page is redirected before any of it loads (no flash of content).
// The rules themselves know nothing about time: whenever the set of sites that
// should be blocked *right now* can change (settings edited, a schedule
// boundary, a temporary unblock granted or expired) syncRules() recomputes it,
// and an alarm is set for the next moment it can change on its own.
//
// Service workers are short-lived, so nothing is cached in memory: every run
// reads storage and the current rules.

const TRANSITION_ALARM = "attention-block-transition";

const blockedPageUrl = (domain) => chrome.runtime.getURL("blocked.html?site=" + encodeURIComponent(domain));

const sameRule = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function applyRules(active) {
    const desired = SETTINGS.buildRules(active);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();

    // Replace only what changed; leaving identical rules alone keeps this
    // cheap enough to run on every transition
    const keptIds = new Set();
    const removeRuleIds = [];
    for (const rule of existing) {
        const wanted = desired.find((r) => r.id === rule.id);
        if (wanted && sameRule(wanted, rule)) keptIds.add(rule.id);
        else removeRuleIds.push(rule.id);
    }
    const addRules = desired.filter((rule) => !keptIds.has(rule.id));

    if (removeRuleIds.length > 0 || addRules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    }
}

// Rules only affect new requests; tabs already showing a site that just became
// blocked are sent to the blocked page too
async function redirectOpenTabs(active) {
    if (active.length === 0) return;
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
        const site = active.find((s) => SETTINGS.domainMatches(s.domain, tab.url));
        if (site) chrome.tabs.update(tab.id, { url: blockedPageUrl(site.domain) }).catch(() => {});
    }
}

async function scheduleNextTransition(sites, unblocks, now) {
    await chrome.alarms.clear(TRANSITION_ALARM);
    const next = SETTINGS.nextTransition(sites, unblocks, now);
    if (next !== null) await chrome.alarms.create(TRANSITION_ALARM, { when: next });
}

async function doSyncRules() {
    const now = new Date();
    const sites = await SETTINGS.loadBlockedSites();
    const unblocks = await SETTINGS.getTempUnblocks(now.getTime());
    const active = SETTINGS.activeSites(sites, unblocks, now);

    await applyRules(active);
    await redirectOpenTabs(active);
    await scheduleNextTransition(sites, unblocks, now);
}

// Several triggers can fire together (a storage change while an alarm runs);
// runs are serialized and collapsed so the last one always sees the final state
let syncing = null;
let syncAgain = false;

function syncRules() {
    if (syncing) {
        syncAgain = true;
        return syncing;
    }
    syncing = doSyncRules()
        .catch((error) => console.error("Attention: updating blocking rules failed", error))
        .finally(() => {
            syncing = null;
            if (syncAgain) {
                syncAgain = false;
                syncRules();
            }
        });
    return syncing;
}

chrome.runtime.onInstalled.addListener(async () => {
    await migrateBookmarksToLocal().catch((error) => console.error("Attention: bookmark migration failed", error));
    await syncRules();
});

// Alarms don't survive the browser closing while they are due, so catch up on start
chrome.runtime.onStartup.addListener(() => syncRules());

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TRANSITION_ALARM) syncRules();
});

chrome.storage.onChanged.addListener((changes, area) => {
    const sitesChanged = area === "sync" && SETTINGS.SITES_KEY in changes;
    const unblocksChanged = area === "local" && SETTINGS.TEMP_UNBLOCKS_KEY in changes;
    if (sitesChanged || unblocksChanged) syncRules();
});

// The blocked page asks for a temporary unblock. The PIN is checked here so the
// page itself never decides whether to lift a block.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "TEMP_UNBLOCK") return false;

    (async () => {
        const { pinHash } = await SETTINGS.loadSettings();
        if (!pinHash) return { ok: false, error: "Set a PIN in Settings to unblock sites temporarily" };
        if (!(await SETTINGS.verifyPin(message.pin))) return { ok: false, error: "Wrong PIN" };

        const expiresAt = await SETTINGS.grantTempUnblock(message.domain, Number(message.minutes));
        // Rules are updated before replying so the page can navigate right away
        await syncRules();
        return { ok: true, expiresAt };
    })()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true; // async response
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
