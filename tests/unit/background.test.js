import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { flushPromises } from "./helpers.js";

let onTabUpdated, onInstalled, onStartup, onAlarm, onStorageChanged, onMessage;

beforeAll(async () => {
    await import("../../background.js");
    onTabUpdated = chrome.__tabUpdatedListeners[0];
    onInstalled = chrome.__installedListeners[0];
    onStartup = chrome.__startupListeners[0];
    onAlarm = chrome.__alarmListeners[0];
    onStorageChanged = chrome.__storageChangedListeners[0];
    onMessage = chrome.__messageListeners[0];
});

const MIGRATION_FLAG = "attention_migration_bookmarks_local";
const SITES_KEY = "attention_blocked_sites";
const SETTINGS_KEY = "attention_settings";
const TEMP_UNBLOCKS_KEY = "attention_temp_unblocks";
const ALARM = "attention-block-transition";

// Lets chained storage/DNR promises settle
const settle = async () => {
    for (let i = 0; i < 5; i++) await flushPromises();
};

const site = (overrides = {}) => ({
    id: "site-" + (overrides.domain ?? "facebook.com"),
    ruleId: 1,
    domain: "facebook.com",
    enabled: true,
    schedule: null,
    ...overrides,
});

const storeSites = (...sites) => {
    chrome.__syncData[SITES_KEY] = JSON.stringify({ nextRuleId: sites.length + 1, sites });
};

const ruleIds = () => chrome.__dynamicRules.map((r) => r.id).sort();

describe("background.js bookmark migration (sync -> local)", () => {
    const runMigration = async () => {
        onInstalled({ reason: "update" });
        await settle();
    };

    it("registers exactly one onInstalled listener", () => {
        expect(chrome.__installedListeners).toHaveLength(1);
        expect(typeof onInstalled).toBe("function");
    });

    it("moves bookmark data from sync to local and marks the migration done", async () => {
        chrome.__syncData.attention_bookmarked_videos = JSON.stringify([{ id: "vid1", title: "One" }]);
        chrome.__syncData.attention_playlists = JSON.stringify([{ id: "favorites", name: "Favorites", videoIds: ["vid1"] }]);
        chrome.__syncData.attention_video_titles = JSON.stringify({ vid1: "One" });
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "Bookmark at 00:00:05" }]);

        await runMigration();

        expect(chrome.__storageData).toEqual({
            attention_bookmarked_videos: JSON.stringify([{ id: "vid1", title: "One" }]),
            attention_playlists: JSON.stringify([{ id: "favorites", name: "Favorites", videoIds: ["vid1"] }]),
            attention_video_titles: JSON.stringify({ vid1: "One" }),
            vid1: JSON.stringify([{ time: 5, desc: "Bookmark at 00:00:05" }]),
            [MIGRATION_FLAG]: true,
        });
        expect(chrome.__syncData).toEqual({});
    });

    it("leaves settings (other attention_ keys) in sync storage", async () => {
        chrome.__syncData.attention_settings = JSON.stringify({ hideShortsReels: { youtubeShorts: true } });
        chrome.__syncData.attention_blocked_sites = JSON.stringify({ nextRuleId: 1, sites: [] });
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "Bookmark at 00:00:05" }]);

        await runMigration();

        expect(chrome.__syncData).toEqual({
            attention_settings: JSON.stringify({ hideShortsReels: { youtubeShorts: true } }),
            attention_blocked_sites: JSON.stringify({ nextRuleId: 1, sites: [] }),
        });
        expect(chrome.__storageData.vid1).toBe(JSON.stringify([{ time: 5, desc: "Bookmark at 00:00:05" }]));
        expect(chrome.__storageData.attention_settings).toBeUndefined();
    });

    it("does not overwrite bookmarks already saved locally on this device", async () => {
        chrome.__storageData.vid1 = JSON.stringify([{ time: 99, desc: "local" }]);
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "synced" }]);
        chrome.__syncData.vid2 = JSON.stringify([{ time: 7, desc: "synced only" }]);

        await runMigration();

        expect(JSON.parse(chrome.__storageData.vid1)).toEqual([{ time: 99, desc: "local" }]);
        expect(JSON.parse(chrome.__storageData.vid2)).toEqual([{ time: 7, desc: "synced only" }]);
        // The stale synced copies are still cleared
        expect(chrome.__syncData).toEqual({});
    });

    it("runs only once: a later install event does not move data again", async () => {
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "first" }]);
        await runMigration();
        expect(chrome.__storageData[MIGRATION_FLAG]).toBe(true);

        chrome.__syncData.vid2 = JSON.stringify([{ time: 6, desc: "arrived later" }]);
        chrome.storage.sync.remove.mockClear();
        await runMigration();

        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.__syncData.vid2).toBeDefined();
        expect(chrome.__storageData.vid2).toBeUndefined();
    });

    it("on a fresh install it only records the flag; no site is blocked by default", async () => {
        await runMigration();

        expect(chrome.__storageData[MIGRATION_FLAG]).toBe(true);
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.__syncData).toEqual({});
        expect(chrome.__dynamicRules).toEqual([]);
    });

    it("writes to local before removing from sync so a failure cannot lose data", async () => {
        // The failure is expected here and is reported to the worker console
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "x" }]);
        chrome.storage.local.set.mockImplementationOnce(() => Promise.reject(new Error("quota")));

        await runMigration();

        // Nothing was removed from sync, and no flag was set, so the next install event retries
        expect(chrome.__syncData.vid1).toBeDefined();
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.__storageData[MIGRATION_FLAG]).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith("Attention: bookmark migration failed", expect.any(Error));
        errorSpy.mockRestore();
    });
});

describe("background.js blocking rules", () => {
    // Friday 2026-11-13 12:00 local time
    const NOW = new Date(2026, 10, 13, 12, 0);

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const startup = async () => {
        onStartup();
        await settle();
    };

    it("registers the startup, alarm, storage and message listeners once", () => {
        expect(chrome.__startupListeners).toHaveLength(1);
        expect(chrome.__alarmListeners).toHaveLength(1);
        expect(chrome.__storageChangedListeners).toHaveLength(1);
        expect(chrome.__messageListeners).toHaveLength(1);
    });

    it("installs a redirect rule for each site blocked right now", async () => {
        storeSites(site(), site({ domain: "reddit.com", ruleId: 2 }));

        await startup();

        expect(chrome.__dynamicRules).toEqual([
            {
                id: 1,
                priority: 1,
                action: { type: "redirect", redirect: { extensionPath: "/blocked.html?site=facebook.com" } },
                condition: { urlFilter: "||facebook.com^", resourceTypes: ["main_frame"] },
            },
            {
                id: 2,
                priority: 1,
                action: { type: "redirect", redirect: { extensionPath: "/blocked.html?site=reddit.com" } },
                condition: { urlFilter: "||reddit.com^", resourceTypes: ["main_frame"] },
            },
        ]);
    });

    it("skips disabled sites, sites outside their schedule and temporarily unblocked sites", async () => {
        storeSites(
            site(),
            site({ domain: "reddit.com", ruleId: 2, enabled: false }),
            site({ domain: "youtube.com", ruleId: 3, schedule: { start: "13:00", end: "18:00", days: [] } }),
            site({ domain: "x.com", ruleId: 4 })
        );
        chrome.__storageData[TEMP_UNBLOCKS_KEY] = JSON.stringify({ "x.com": NOW.getTime() + 60_000 });

        await startup();

        expect(ruleIds()).toEqual([1]);
    });

    it("removes rules that no longer apply and keeps unchanged ones untouched", async () => {
        chrome.__dynamicRules.push(
            ...globalThis.ATTENTION_SETTINGS.buildRules([site(), site({ domain: "reddit.com", ruleId: 2 })])
        );
        storeSites(site()); // reddit.com was removed from the settings

        await startup();

        expect(ruleIds()).toEqual([1]);
        expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [2], addRules: [] });
    });

    it("does not call updateDynamicRules when nothing changed", async () => {
        chrome.__dynamicRules.push(...globalThis.ATTENTION_SETTINGS.buildRules([site()]));
        storeSites(site());

        await startup();

        expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });

    it("replaces a rule whose id is reused for a different domain", async () => {
        chrome.__dynamicRules.push(...globalThis.ATTENTION_SETTINGS.buildRules([site()]));
        storeSites(site({ domain: "reddit.com", ruleId: 1 }));

        await startup();

        expect(chrome.__dynamicRules.map((r) => r.condition.urlFilter)).toEqual(["||reddit.com^"]);
    });

    it("sends open tabs on a newly blocked site to the blocked page", async () => {
        storeSites(site());
        chrome.tabs.query.mockResolvedValue([
            { id: 1, url: "https://m.facebook.com/reels" },
            { id: 2, url: "https://www.youtube.com/" },
            { id: 3, url: "chrome-extension://test-extension-id/blocked.html?site=facebook.com" },
            { id: 4 }, // no url access
        ]);

        await startup();

        expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.update).toHaveBeenCalledWith(1, {
            url: "chrome-extension://test-extension-id/blocked.html?site=facebook.com",
        });
    });

    it("does not query tabs when no site is blocked", async () => {
        storeSites(site({ enabled: false }));

        await startup();

        expect(chrome.tabs.query).not.toHaveBeenCalled();
    });

    it("sets an alarm for the next schedule boundary", async () => {
        storeSites(site({ schedule: { start: "13:00", end: "18:00", days: [] } }));

        await startup();

        expect(chrome.alarms.clear).toHaveBeenCalledWith(ALARM);
        expect(chrome.alarms.create).toHaveBeenCalledWith(ALARM, { when: new Date(2026, 10, 13, 13, 0).getTime() });
    });

    it("sets an alarm for a temporary unblock expiry", async () => {
        storeSites(site());
        const expiry = NOW.getTime() + 15 * 60_000;
        chrome.__storageData[TEMP_UNBLOCKS_KEY] = JSON.stringify({ "facebook.com": expiry });

        await startup();

        expect(chrome.alarms.create).toHaveBeenCalledWith(ALARM, { when: expiry });
    });

    it("clears the alarm when nothing will change on its own", async () => {
        storeSites(site());

        await startup();

        expect(chrome.alarms.clear).toHaveBeenCalledWith(ALARM);
        expect(chrome.alarms.create).not.toHaveBeenCalled();
    });

    it("re-syncs when the transition alarm fires, ignoring other alarms", async () => {
        storeSites(site());

        onAlarm({ name: "something-else" });
        await settle();
        expect(ruleIds()).toEqual([]);

        onAlarm({ name: ALARM });
        await settle();
        expect(ruleIds()).toEqual([1]);
    });

    it("re-syncs when the blocked sites change in sync storage", async () => {
        storeSites(site());

        onStorageChanged({ [SITES_KEY]: { newValue: chrome.__syncData[SITES_KEY] } }, "sync");
        await settle();

        expect(ruleIds()).toEqual([1]);
    });

    it("re-syncs when temporary unblocks change in local storage", async () => {
        storeSites(site());

        onStorageChanged({ [TEMP_UNBLOCKS_KEY]: { newValue: "{}" } }, "local");
        await settle();

        expect(ruleIds()).toEqual([1]);
    });

    it("ignores unrelated storage changes (bookmarks, other settings)", async () => {
        storeSites(site());

        onStorageChanged({ vid1: { newValue: "[]" } }, "local");
        onStorageChanged({ [SETTINGS_KEY]: { newValue: "{}" } }, "sync");
        onStorageChanged({ [SITES_KEY]: { newValue: "{}" } }, "local"); // wrong area
        await settle();

        expect(chrome.declarativeNetRequest.getDynamicRules).not.toHaveBeenCalled();
    });

    it("collapses overlapping triggers into serialized runs", async () => {
        storeSites(site());

        onStartup();
        onAlarm({ name: ALARM });
        onStorageChanged({ [SITES_KEY]: { newValue: "x" } }, "sync");
        await settle();

        expect(ruleIds()).toEqual([1]);
        // One run for the first trigger, one collapsed run for the two that arrived while it was busy
        expect(chrome.declarativeNetRequest.getDynamicRules).toHaveBeenCalledTimes(2);
    });

    it("reports and survives a failing rule update", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        storeSites(site());
        chrome.declarativeNetRequest.updateDynamicRules.mockImplementationOnce(() => Promise.reject(new Error("boom")));

        await startup();
        expect(errorSpy).toHaveBeenCalledWith("Attention: updating blocking rules failed", expect.any(Error));

        await startup(); // next run works again
        expect(ruleIds()).toEqual([1]);
        errorSpy.mockRestore();
    });
});

describe("background.js TEMP_UNBLOCK message", () => {
    const NOW = new Date(2026, 10, 13, 12, 0);
    const SETTINGS = () => globalThis.ATTENTION_SETTINGS;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const send = async (message) => {
        const sendResponse = vi.fn();
        const isAsync = onMessage(message, {}, sendResponse);
        await settle();
        return { isAsync, response: sendResponse.mock.calls[0]?.[0] };
    };

    it("ignores other messages synchronously", () => {
        const sendResponse = vi.fn();
        expect(onMessage({ type: "SOMETHING" }, {}, sendResponse)).toBe(false);
        expect(onMessage(undefined, {}, sendResponse)).toBe(false);
        expect(sendResponse).not.toHaveBeenCalled();
    });

    it("refuses when no PIN is set", async () => {
        storeSites(site());

        const { isAsync, response } = await send({ type: "TEMP_UNBLOCK", domain: "facebook.com", minutes: 15, pin: "1234" });

        expect(isAsync).toBe(true);
        expect(response).toEqual({ ok: false, error: "Set a PIN in Settings to unblock sites temporarily" });
        expect(chrome.__storageData[TEMP_UNBLOCKS_KEY]).toBeUndefined();
    });

    it("refuses a wrong PIN", async () => {
        storeSites(site());
        await SETTINGS().setPin("1234");

        const { response } = await send({ type: "TEMP_UNBLOCK", domain: "facebook.com", minutes: 15, pin: "0000" });

        expect(response).toEqual({ ok: false, error: "Wrong PIN" });
        expect(JSON.parse(chrome.__storageData[TEMP_UNBLOCKS_KEY] ?? "{}")).toEqual({});
    });

    it("with the right PIN lifts the rule, records the expiry and replies once rules are updated", async () => {
        storeSites(site());
        await SETTINGS().setPin("1234");
        chrome.__dynamicRules.push(...SETTINGS().buildRules([site()]));

        const { response } = await send({ type: "TEMP_UNBLOCK", domain: "facebook.com", minutes: 15, pin: " 1234 " });

        const expiresAt = NOW.getTime() + 15 * 60_000;
        expect(response).toEqual({ ok: true, expiresAt });
        expect(JSON.parse(chrome.__storageData[TEMP_UNBLOCKS_KEY])).toEqual({ "facebook.com": expiresAt });
        expect(ruleIds()).toEqual([]);
        expect(chrome.alarms.create).toHaveBeenCalledWith(ALARM, { when: expiresAt });
    });

    it("reports an invalid duration", async () => {
        storeSites(site());
        await SETTINGS().setPin("1234");

        const { response } = await send({ type: "TEMP_UNBLOCK", domain: "facebook.com", minutes: 0, pin: "1234" });

        expect(response).toEqual({ ok: false, error: "Choose how long to unblock for" });
    });
});

describe("background.js STATS_EVENT message", () => {
    const NOW = new Date(2026, 10, 12, 15, 0);
    const TODAY_KEY = "attention_stats_day_2026-11-12";

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const send = async (message) => {
        const sendResponse = vi.fn();
        const isAsync = onMessage(message, {}, sendResponse);
        await settle();
        return { isAsync, response: sendResponse.mock.calls[0]?.[0] };
    };

    const today = () => JSON.parse(chrome.__storageData[TODAY_KEY]);

    it("records events reported by content scripts and the blocked page", async () => {
        const removal = await send({ type: "STATS_EVENT", event: { event: "removal", kind: "shorts", count: 3 } });
        await send({ type: "STATS_EVENT", event: { event: "redirect", kind: "reels" } });
        await send({ type: "STATS_EVENT", event: { event: "blockedVisit", domain: "reddit.com" } });

        expect(removal).toEqual({ isAsync: true, response: { ok: true } });
        expect(today()).toMatchObject({ shortsRemoved: 3, reelsRedirects: 1, blockedVisits: { "reddit.com": 1 } });
    });

    it("applies reports from several tabs at once without losing any", async () => {
        const sendResponse = vi.fn();
        for (let i = 0; i < 10; i++) {
            onMessage({ type: "STATS_EVENT", event: { event: "removal", kind: "reels", count: 1 } }, {}, sendResponse);
        }
        await settle();
        await settle();

        expect(sendResponse).toHaveBeenCalledTimes(10);
        expect(today().reelsRemoved).toBe(10);
    });

    it.each([
        { event: "unblock", domain: "reddit.com", minutes: 60 },
        { event: "screenTime", domain: "youtube.com", ms: 1000 },
    ])("refuses %j, which only the worker itself may record", async (event) => {
        const { response } = await send({ type: "STATS_EVENT", event });

        expect(response).toEqual({ ok: false, error: "This statistic can't be reported from a page" });
        expect(chrome.__storageData[TODAY_KEY]).toBeUndefined();
    });

    it("reports malformed events without recording them", async () => {
        const { response } = await send({ type: "STATS_EVENT", event: { event: "removal", kind: "shorts", count: -1 } });
        const missing = await send({ type: "STATS_EVENT" });

        expect(response.ok).toBe(false);
        expect(response.error).toMatch(/Invalid stats event/);
        expect(missing.response.ok).toBe(false);
        expect(chrome.__storageData[TODAY_KEY]).toBeUndefined();
    });

    it("ignores message types that only exist on Object.prototype", () => {
        const sendResponse = vi.fn();
        expect(onMessage({ type: "toString" }, {}, sendResponse)).toBe(false);
        expect(onMessage({ type: "constructor" }, {}, sendResponse)).toBe(false);
    });
});

describe("background.js tab listener", () => {
    beforeEach(() => {
        chrome.tabs.sendMessage.mockImplementation(() => Promise.resolve());
    });

    it("registers exactly one onUpdated listener", () => {
        expect(chrome.__tabUpdatedListeners).toHaveLength(1);
        expect(typeof onTabUpdated).toBe("function");
    });

    it("sends yt-watch NEW with the video id when a watch page finishes loading", () => {
        onTabUpdated(7, { status: "complete" }, { url: "https://www.youtube.com/watch?v=abc123&t=10s" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
            url: "https://www.youtube.com/watch?v=abc123&t=10s",
            source: "yt-watch",
            type: "NEW",
            videoId: "abc123",
        });
    });

    it("sends yt-home for non-watch YouTube pages", () => {
        onTabUpdated(3, { status: "complete" }, { url: "https://www.youtube.com/" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(3, {
            url: "https://www.youtube.com/",
            source: "yt-home",
        });
    });

    it("sends fb for Facebook pages", () => {
        onTabUpdated(5, { status: "complete" }, { url: "https://www.facebook.com/reels" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(5, {
            url: "https://www.facebook.com/reels",
            source: "fb",
        });
    });

    it("sends on in-page (SPA) URL changes even without a complete status", () => {
        onTabUpdated(9, { url: "https://www.youtube.com/watch?v=spa" }, { url: "https://www.youtube.com/watch?v=spa" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ source: "yt-watch", videoId: "spa" });
    });

    it("ignores intermediate updates (loading, title, favicon)", () => {
        const tab = { url: "https://www.youtube.com/" };
        onTabUpdated(1, { status: "loading" }, tab);
        onTabUpdated(1, { title: "YouTube" }, tab);
        onTabUpdated(1, { favIconUrl: "https://www.youtube.com/favicon.ico" }, tab);

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("ignores tabs on other sites", () => {
        onTabUpdated(2, { status: "complete" }, { url: "https://example.com/watch?v=nope" });
        onTabUpdated(4, { status: "complete" }, { url: undefined });

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("swallows sendMessage rejections (content script not injected yet)", async () => {
        chrome.tabs.sendMessage.mockImplementation(() =>
            Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
        );

        expect(() => onTabUpdated(1, { status: "complete" }, { url: "https://www.youtube.com/" })).not.toThrow();
        // Let the rejected promise settle; an unhandled rejection would fail the test run
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
