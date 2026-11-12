import { test, expect, blockSite } from "./extension.js";

const SHORTS_RULE_ID = 1_000_001;
const REELS_RULE_ID = 1_000_002;

// Waits until the worker's Shorts/Reels redirect rules are exactly `ids`
const expectRedirectRules = (serviceWorker, ids) =>
    expect
        .poll(() =>
            serviceWorker.evaluate(async () =>
                (await chrome.declarativeNetRequest.getDynamicRules())
                    .map((r) => r.id)
                    .filter((id) => id > 1_000_000)
                    .sort()
            )
        )
        .toEqual(ids);

const todayStats = (serviceWorker) =>
    serviceWorker.evaluate(async () => {
        const STATS = globalThis.ATTENTION_STATS;
        const days = await STATS.loadDays([STATS.dayKey()]);
        return STATS.dayTotals(days[STATS.dayKey()]);
    });

const setToggle = (serviceWorker, toggle, hidden) =>
    serviceWorker.evaluate(([t, h]) => globalThis.ATTENTION_SETTINGS.setHideToggle(t, h), [toggle, hidden]);

// Navigates the way the sites' own scripts do (main world, no network request)
// and waits for the page that loads instead
const pushStateAndWaitForReload = async (page, path) => {
    await page.evaluate(() => (window.__beforeRedirect = true));
    await page.evaluate((p) => history.pushState({}, "", p), path);
    await page.waitForFunction(() => !window.__beforeRedirect && document.readyState !== "loading");
};

test.describe("Shorts and Reels pages", () => {
    test.beforeEach(async ({ serviceWorker }) => {
        await expectRedirectRules(serviceWorker, [SHORTS_RULE_ID, REELS_RULE_ID]);
    });

    test("opening a Short directly lands on the YouTube home page, without loading the Short", async ({
        page,
        serviceWorker,
    }) => {
        const requested = [];
        page.on("request", (request) => requested.push(request.url()));

        await page.goto("https://www.youtube.com/shorts/abc123?feature=share");

        // The marker the rule adds is counted and removed from the address bar
        await expect.poll(() => page.url()).toBe("https://www.youtube.com/");
        expect(requested.some((url) => url.includes("/shorts/"))).toBe(false);
        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ shortsRedirects: 1 });
    });

    test("opening a Reel or the Reels tab directly lands on the Facebook home page", async ({ page, serviceWorker }) => {
        await page.goto("https://www.facebook.com/reel/123456789/");
        await expect.poll(() => page.url()).toBe("https://www.facebook.com/");

        await page.goto("https://www.facebook.com/reels/");
        await expect.poll(() => page.url()).toBe("https://www.facebook.com/");

        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ reelsRedirects: 2 });
    });

    test("a Short opened from inside YouTube (history.pushState) is left for the home page", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/");

        await pushStateAndWaitForReload(page, "/shorts/abc123");

        expect(page.url()).toBe("https://www.youtube.com/");
        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ shortsRedirects: 1 });
    });

    test("a Reel opened from inside Facebook is left for the home page", async ({ page, serviceWorker }) => {
        await page.goto("https://www.facebook.com/");

        // The fixture page doesn't change its DOM: only the Navigation API can notice this
        await pushStateAndWaitForReload(page, "/reel/987/");

        expect(page.url()).toBe("https://www.facebook.com/");
        await expect.poll(() => todayStats(serviceWorker)).toMatchObject({ reelsRedirects: 1 });
    });

    test("other YouTube pages that mention shorts are left alone", async ({ page }) => {
        await page.goto("https://www.youtube.com/@channel/shorts");
        expect(page.url()).toBe("https://www.youtube.com/@channel/shorts");

        await page.goto("https://www.youtube.com/watch?v=shorts");
        expect(page.url()).toBe("https://www.youtube.com/watch?v=shorts");
    });

    test("with 'Hide YouTube Shorts' off, Shorts open normally; Reels are still redirected", async ({
        page,
        serviceWorker,
    }) => {
        await setToggle(serviceWorker, "youtubeShorts", false);
        await expectRedirectRules(serviceWorker, [REELS_RULE_ID]);

        await page.goto("https://www.youtube.com/shorts/abc123");
        expect(page.url()).toBe("https://www.youtube.com/shorts/abc123");

        await page.goto("https://www.facebook.com/reel/1");
        await expect.poll(() => page.url()).toBe("https://www.facebook.com/");
    });

    test("switching 'Hide YouTube Shorts' on while a Short is open leaves it", async ({ page, serviceWorker }) => {
        await setToggle(serviceWorker, "youtubeShorts", false);
        await expectRedirectRules(serviceWorker, [REELS_RULE_ID]);
        await page.goto("https://www.youtube.com/shorts/abc123");

        await setToggle(serviceWorker, "youtubeShorts", true);

        await expect.poll(() => page.url()).toBe("https://www.youtube.com/");
    });

    test("a Short on a blocked YouTube still ends on the blocked page", async ({ page, serviceWorker }) => {
        await blockSite(serviceWorker, "youtube.com");

        await page.goto("https://www.youtube.com/shorts/abc123");

        await expect(page.locator("h1")).toHaveText("youtube.com is blocked");
    });
});
