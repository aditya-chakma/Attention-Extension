import { test, expect, blockSite } from "./extension.js";

test.describe("Website blocking", () => {
    test("nothing is blocked out of the box", async ({ page, serviceWorker }) => {
        expect(await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.loadBlockedSites())).toEqual([]);

        await page.goto("https://www.facebook.com/");
        expect(page.url()).toBe("https://www.facebook.com/");
    });

    test("a blocked site is redirected to the extension's blocked page before it loads", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await blockSite(serviceWorker, "facebook.com");
        // Blocking is a declarativeNetRequest redirect rule, so the Facebook
        // page itself is never fetched
        let facebookRequested = false;
        page.on("request", (request) => {
            if (request.url().startsWith("https://www.facebook.com/")) facebookRequested = true;
        });

        await page.goto("https://www.facebook.com/");

        expect(page.url()).toBe(`chrome-extension://${extensionId}/blocked.html?site=facebook.com`);
        await expect(page.locator("h1")).toHaveText("facebook.com is blocked");
        await expect(page.locator(".blocked-reason")).toHaveText("Blocked all day, every day.");
        expect(facebookRequested).toBe(false);
    });

    test("the blocked page is dark themed and, without a PIN, points to Settings", async ({ page, serviceWorker }) => {
        await blockSite(serviceWorker, "facebook.com");
        await page.goto("https://www.facebook.com/");

        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");
        await expect(page.locator("header a.brand")).toHaveText("Attention");
        await expect(page.locator("#unblock-form")).toHaveCount(0);
        await expect(page.locator(".blocked-note")).toHaveText("To unblock a site for a while, set a PIN in Settings.");
    });

    test("the blocked page describes the site's schedule", async ({ page, serviceWorker }) => {
        await blockSite(serviceWorker, "facebook.com");
        await serviceWorker.evaluate(async () => {
            const S = globalThis.ATTENTION_SETTINGS;
            const [facebook] = await S.loadBlockedSites();
            // Keep the site blocked right now whatever the time: a window that
            // covers the whole day except one minute
            await S.setSchedule(facebook.id, { start: "00:01", end: "00:00", days: [] });
        });
        await page.goto("https://www.facebook.com/");

        await expect(page.locator(".blocked-reason")).toHaveText("Blocked from 12:01 AM to 12:00 AM every day.");
        await expect(page.locator(".blocked-until")).toHaveText("Blocked until 12:00 AM");
    });

    test("subdomains of a blocked site are blocked too", async ({ page, serviceWorker, extensionId }) => {
        await blockSite(serviceWorker, "facebook.com");
        await page.goto("https://m.facebook.com/reels");

        expect(page.url()).toBe(`chrome-extension://${extensionId}/blocked.html?site=facebook.com`);
    });

    test("youtube.com is not blocked", async ({ page }) => {
        await page.goto("https://www.youtube.com/");
        await page.waitForTimeout(500);

        expect(page.url()).toBe("https://www.youtube.com/");
    });

    test("a site added to the blocked list is blocked right away, and unblocked when removed", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await page.context().route("https://example.com/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "<h1>Example</h1>" })
        );

        await page.goto("https://example.com/");
        expect(page.url()).toBe("https://example.com/");

        const site = await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.addSite("example.com"));
        // Open tabs on the site are sent to the blocked page as soon as the rules update
        await page.waitForURL(`chrome-extension://${extensionId}/blocked.html?site=example.com`);

        await serviceWorker.evaluate((id) => globalThis.ATTENTION_SETTINGS.removeSite(id), site.id);
        await expect
            .poll(() => serviceWorker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()))
            .not.toContainEqual(expect.objectContaining({ condition: expect.objectContaining({ urlFilter: "||example.com^" }) }));

        await page.goto("https://example.com/");
        expect(page.url()).toBe("https://example.com/");
    });

    test("the unblock form refuses a wrong PIN and, with the right one, opens the site", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await blockSite(serviceWorker, "facebook.com");
        await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.setPin("1234"));

        await page.goto("https://www.facebook.com/");
        expect(page.url()).toBe(`chrome-extension://${extensionId}/blocked.html?site=facebook.com`);

        const form = page.locator("#unblock-form");
        await form.locator("#pin").fill("0000");
        await form.locator("#duration").selectOption("5");
        await form.locator("button[type=submit]").click();
        await expect(form.locator("#unblock-error")).toHaveText("Wrong PIN");
        expect(page.url()).toBe(`chrome-extension://${extensionId}/blocked.html?site=facebook.com`);

        await form.locator("#pin").fill("1234");
        await form.locator("button[type=submit]").click();

        await page.waitForURL("https://facebook.com/");
        const unblocks = await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.getTempUnblocks());
        expect(Object.keys(unblocks)).toEqual(["facebook.com"]);
        expect(unblocks["facebook.com"]).toBeGreaterThan(Date.now() + 4 * 60_000);
        expect(unblocks["facebook.com"]).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    });

    test("the blocked page follows a change made elsewhere and offers to continue", async ({ page, serviceWorker }) => {
        await blockSite(serviceWorker, "facebook.com");
        await page.goto("https://www.facebook.com/");
        await expect(page.locator("a.continue-link")).toHaveCount(0);

        await serviceWorker.evaluate(async () => {
            const S = globalThis.ATTENTION_SETTINGS;
            const [facebook] = await S.loadBlockedSites();
            await S.toggleSite(facebook.id, false);
        });

        await expect(page.locator(".blocked-reason")).toHaveText("This site is not blocked right now.");
        await expect(page.locator("a.continue-link")).toHaveAttribute("href", "https://facebook.com/");
    });
});
