import { test, expect, blockSite } from "./extension.js";

// Everything here runs through real Chrome events (tab URL changes and
// activation) and the real worker; headless Chromium reports its window as
// focused and the user as active.

const screenTimeToday = (serviceWorker) =>
    serviceWorker.evaluate(async () => {
        const STATS = globalThis.ATTENTION_STATS;
        const days = await STATS.loadDays([STATS.dayKey()]);
        return days[STATS.dayKey()]?.screenTimeMs ?? {};
    });

const measuring = (serviceWorker) =>
    serviceWorker.evaluate(async () => {
        const raw = (await chrome.storage.session.get("attention_screen_time_session")).attention_screen_time_session;
        return raw ? JSON.parse(raw).domain : null;
    });

test.describe("Screen time", () => {
    test.beforeEach(async ({ context }) => {
        await context.route("https://example.com/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "<h1>Example</h1>" })
        );
    });

    test("time on YouTube is credited when the tab moves to an untracked site", async ({ page, serviceWorker }) => {
        await page.goto("https://www.youtube.com/");
        await expect.poll(() => measuring(serviceWorker)).toBe("youtube.com");

        await page.waitForTimeout(1500);
        await page.goto("https://example.com/");

        await expect.poll(() => measuring(serviceWorker)).toBeNull();
        const credited = (await screenTimeToday(serviceWorker))["youtube.com"];
        expect(credited).toBeGreaterThanOrEqual(1000);
        expect(credited).toBeLessThan(30_000);
    });

    test("switching tabs moves the time to the site now on screen", async ({ context, page, serviceWorker }) => {
        await page.goto("https://www.youtube.com/");
        await expect.poll(() => measuring(serviceWorker)).toBe("youtube.com");
        await page.waitForTimeout(1200);

        const facebook = await context.newPage();
        await facebook.goto("https://www.facebook.com/");
        await expect.poll(() => measuring(serviceWorker)).toBe("facebook.com");
        await expect.poll(async () => (await screenTimeToday(serviceWorker))["youtube.com"] ?? 0).toBeGreaterThanOrEqual(1000);

        await facebook.waitForTimeout(1200);
        await page.bringToFront();
        await expect.poll(() => measuring(serviceWorker)).toBe("youtube.com");
        await expect.poll(async () => (await screenTimeToday(serviceWorker))["facebook.com"] ?? 0).toBeGreaterThanOrEqual(1000);
    });

    test("sites on the block list are tracked while they are allowed through", async ({ page, serviceWorker }) => {
        const site = await blockSite(serviceWorker, "example.com");
        await serviceWorker.evaluate((id) => globalThis.ATTENTION_SETTINGS.toggleSite(id, false), site.id);
        await expect
            .poll(() => serviceWorker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length))
            .toBe(2); // only the Shorts and Reels page redirects

        await page.goto("https://example.com/");

        await expect.poll(() => measuring(serviceWorker)).toBe("example.com");
    });

    test("the blocked page itself isn't screen time", async ({ page, serviceWorker }) => {
        await blockSite(serviceWorker, "example.com");

        await page.goto("https://example.com/");
        await expect(page.locator("h1")).toHaveText("example.com is blocked");

        await page.waitForTimeout(300);
        expect(await measuring(serviceWorker)).toBeNull();
    });
});
