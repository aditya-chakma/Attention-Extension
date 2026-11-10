import { test, expect } from "./extension.js";

test.describe("Website blocking", () => {
    test("facebook.com is redirected to the extension's blocked page before it loads", async ({ page, extensionId }) => {
        // Blocking is a declarativeNetRequest redirect rule, so the Facebook
        // page itself is never fetched
        let facebookRequested = false;
        page.on("request", (request) => {
            if (request.url().startsWith("https://www.facebook.com/")) facebookRequested = true;
        });

        await page.goto("https://www.facebook.com/");

        expect(page.url()).toBe(`chrome-extension://${extensionId}/blocked.html?site=facebook.com`);
        await expect(page.locator("h1")).toHaveText("URL Blocked");
        expect(facebookRequested).toBe(false);
    });

    test("subdomains of a blocked site are blocked too", async ({ page, extensionId }) => {
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

    test("a temporary unblock with the right PIN lets the site through", async ({ page, serviceWorker, extensionId }) => {
        await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.setPin("1234"));

        await page.goto("https://www.facebook.com/");
        expect(page.url()).toBe(`chrome-extension://${extensionId}/blocked.html?site=facebook.com`);

        const refused = await page.evaluate(() =>
            chrome.runtime.sendMessage({ type: "TEMP_UNBLOCK", domain: "facebook.com", minutes: 5, pin: "0000" })
        );
        expect(refused).toEqual({ ok: false, error: "Wrong PIN" });

        const granted = await page.evaluate(() =>
            chrome.runtime.sendMessage({ type: "TEMP_UNBLOCK", domain: "facebook.com", minutes: 5, pin: "1234" })
        );
        expect(granted.ok).toBe(true);

        await page.goto("https://www.facebook.com/");
        expect(page.url()).toBe("https://www.facebook.com/");
    });
});
