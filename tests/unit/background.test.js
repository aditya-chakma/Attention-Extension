import { describe, it, expect, beforeAll, beforeEach } from "vitest";

let onTabUpdated, onInstalled;

beforeAll(async () => {
    await import("../../background.js");
    onTabUpdated = chrome.__tabUpdatedListeners[0];
    onInstalled = chrome.__installedListeners[0];
});

const MIGRATION_FLAG = "attention_migration_bookmarks_local";
const SITES_KEY = "attention_blocked_sites";

// onInstalled also seeds the default blocked sites into sync storage
const seededSites = () => {
    const record = JSON.parse(chrome.__syncData[SITES_KEY]);
    return record.sites.map((s) => s.domain);
};

describe("background.js bookmark migration (sync -> local)", () => {
    const runMigration = async () => {
        onInstalled({ reason: "update" });
        // Let the chained get/set/remove promises settle
        for (let i = 0; i < 10; i++) await Promise.resolve();
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
        // Only the seeded default settings remain in sync storage
        expect(Object.keys(chrome.__syncData)).toEqual([SITES_KEY]);
        expect(seededSites()).toEqual(["facebook.com"]);
    });

    it("leaves settings (other attention_ keys) in sync storage", async () => {
        chrome.__syncData.attention_settings = JSON.stringify({ hideShortsReels: { youtubeShorts: true } });
        chrome.__syncData.attention_blocked_sites = JSON.stringify([{ domain: "facebook.com" }]);
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "Bookmark at 00:00:05" }]);

        await runMigration();

        expect(chrome.__syncData).toEqual({
            attention_settings: JSON.stringify({ hideShortsReels: { youtubeShorts: true } }),
            attention_blocked_sites: JSON.stringify([{ domain: "facebook.com" }]),
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
        expect(Object.keys(chrome.__syncData)).toEqual([SITES_KEY]);
    });

    it("runs only once: a later install event does not touch storage again", async () => {
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "first" }]);
        await runMigration();
        expect(chrome.__storageData[MIGRATION_FLAG]).toBe(true);

        chrome.__syncData.vid2 = JSON.stringify([{ time: 6, desc: "arrived later" }]);
        chrome.storage.local.set.mockClear();
        chrome.storage.sync.remove.mockClear();
        await runMigration();

        expect(chrome.storage.local.set).not.toHaveBeenCalled();
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.__syncData.vid2).toBeDefined();
    });

    it("on a fresh install it records the flag and seeds facebook.com as a blocked site", async () => {
        await runMigration();

        expect(chrome.__storageData).toEqual({ [MIGRATION_FLAG]: true });
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(seededSites()).toEqual(["facebook.com"]);
    });

    it("never re-seeds sites the user has since removed", async () => {
        chrome.__syncData[SITES_KEY] = JSON.stringify({ nextRuleId: 2, sites: [] });

        await runMigration();

        expect(seededSites()).toEqual([]);
    });

    it("writes to local before removing from sync so a failure cannot lose data", async () => {
        chrome.__syncData.vid1 = JSON.stringify([{ time: 5, desc: "x" }]);
        chrome.storage.local.set.mockImplementationOnce(() => Promise.reject(new Error("quota")));

        await runMigration();

        // Nothing was removed from sync, and no flag was set, so the next install event retries
        expect(chrome.__syncData.vid1).toBeDefined();
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.__storageData[MIGRATION_FLAG]).toBeUndefined();
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
