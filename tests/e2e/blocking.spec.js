import { test, expect } from "./extension.js";

test.describe("Website blocking", () => {
    test("facebook.com is redirected to the extension's blocked page", async ({ page, extensionId }) => {
        // The content script navigates away right after the page loads, so
        // don't wait for the full load event of the Facebook page
        await page.goto("https://www.facebook.com/", { waitUntil: "commit" });

        await page.waitForURL(`chrome-extension://${extensionId}/blocked.html`);
        await expect(page.locator("h1")).toHaveText("URL Blocked");
        await expect(page.locator('[aria-label="Reels"]')).toHaveCount(0);
    });

    test("youtube.com is not blocked", async ({ page }) => {
        await page.goto("https://www.youtube.com/");
        await page.waitForTimeout(500);

        expect(page.url()).toBe("https://www.youtube.com/");
    });
});
