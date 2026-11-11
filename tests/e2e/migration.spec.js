import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Launches Chromium with the unpacked extension on a reusable profile, so a
// second launch sees the storage left behind by the first one
const launch = async (userDataDir) => {
    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: "chromium",
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    return { context, worker };
};

// Older versions kept bookmarks in chrome.storage.sync. On install/update the
// background worker moves them to chrome.storage.local (settings stay in sync).
test.describe("Bookmark storage migration", () => {
    test("bookmarks left in sync storage by an older version are moved to local storage on update", async ({}, testInfo) => {
        const synced = {
            attention_bookmarked_videos: JSON.stringify([{ id: "old", title: "Old video", channel: "C", time: 1, savedAt: 1 }]),
            attention_playlists: JSON.stringify([{ id: "favorites", name: "Favorites", videoIds: ["old"] }]),
            attention_video_titles: JSON.stringify({ old: "Old video" }),
            old: JSON.stringify([{ time: 1, desc: "Bookmark at 00:00:01" }]),
            // A future setting: must stay where it is
            attention_settings: JSON.stringify({ example: true }),
        };
        const userDataDir = testInfo.outputPath("profile");

        // First run: leave the profile the way an older version would have
        {
            const { context, worker } = await launch(userDataDir);
            // Let the install-time migration finish before wiping its flag
            await expect
                .poll(() => worker.evaluate(() => chrome.storage.local.get("attention_migration_bookmarks_local")))
                .toEqual({ attention_migration_bookmarks_local: true });
            await worker.evaluate(async (data) => {
                await chrome.storage.local.clear();
                await chrome.storage.sync.set(data);
            }, synced);
            await context.close();
        }

        // Second run: loading the unpacked extension again fires onInstalled
        const { context, worker } = await launch(userDataDir);
        try {
            await expect
                .poll(() => worker.evaluate(() => chrome.storage.local.get(null)), { timeout: 10000 })
                .toEqual({
                    attention_bookmarked_videos: synced.attention_bookmarked_videos,
                    attention_playlists: synced.attention_playlists,
                    attention_video_titles: synced.attention_video_titles,
                    old: synced.old,
                    attention_migration_bookmarks_local: true,
                });
            // Settings stay in sync storage, untouched
            expect(await worker.evaluate(() => chrome.storage.sync.get(null))).toEqual({
                attention_settings: synced.attention_settings,
            });
        } finally {
            await context.close();
        }
    });
});
