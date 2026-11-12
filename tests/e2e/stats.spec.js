import { test, expect, blockSite } from "./extension.js";

// Reads today's statistics record through the real service worker
const todayStats = (serviceWorker) =>
    serviceWorker.evaluate(async () => {
        const STATS = globalThis.ATTENTION_STATS;
        const days = await STATS.loadDays([STATS.dayKey()]);
        return STATS.dayTotals(days[STATS.dayKey()]);
    });

test.describe("Usage statistics", () => {
    test("Shorts removed on YouTube and Reels removed on Facebook are counted", async ({ page, serviceWorker }) => {
        // The extension was installed a moment ago: a page loading before the
        // new worker has registered its listeners would lose its report (an
        // install-time race only; later, Chrome wakes the worker on demand)
        await serviceWorker.evaluate(() => true);
        await page.goto("https://www.youtube.com/");
        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);
        await page.goto("https://www.facebook.com/");
        await expect(page.locator('[aria-label="Reels"]')).toHaveCount(0);

        // The fixtures hold two empty Shorts shelves and one Reels section
        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ shortsRemoved: 2, reelsRemoved: 1 });
    });

    test("opening a blocked site counts one visit; reloading the blocked page doesn't", async ({ page, serviceWorker }) => {
        await blockSite(serviceWorker, "facebook.com");

        await page.goto("https://www.facebook.com/");
        await expect(page.locator("h1")).toHaveText("facebook.com is blocked");
        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ blockedVisits: 1 });

        await page.reload();
        await expect(page.locator("h1")).toHaveText("facebook.com is blocked");
        await page.goto("https://www.facebook.com/");
        await expect(page.locator("h1")).toHaveText("facebook.com is blocked");

        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ blockedVisits: 2 });
    });
});
