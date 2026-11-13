import { test, expect, blockSite } from "./extension.js";

test.describe("Settings page", () => {
    const pageUrl = (extensionId) => `chrome-extension://${extensionId}/settings.html`;

    test("is dark themed, has no bookmark tabs, and is reached from the header link next to the brand", async ({
        page,
        extensionId,
    }) => {
        await page.goto(pageUrl(extensionId));

        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");
        await expect(page.locator("header #settings-link")).toHaveAttribute("aria-current", "page");
        await expect(page.locator("header #settings-link svg")).toBeVisible();
        await expect(page.locator(".tabs")).toHaveCount(0);

        // The bookmark tabs live on the pages behind the "Attention" brand
        await page.locator("header a.brand").click();
        await expect(page).toHaveURL(`chrome-extension://${extensionId}/videos.html`);
        await expect(page.locator("#tab-videos")).toBeVisible();
        await expect(page.locator("#tab-timestamps")).toBeVisible();
        await expect(page.locator("#tab-settings")).toHaveCount(0);

        await page.locator("header #settings-link").click();
        await expect(page).toHaveURL(pageUrl(extensionId));
    });

    test("starts empty and adds a typed site normalized", async ({ page, extensionId }) => {
        await page.goto(pageUrl(extensionId));
        await expect(page.locator(".site-empty")).toHaveText("No blocked sites. Add one above.");

        await page.locator("#add-site-input").fill("https://www.Reddit.com/r/all");
        await page.locator("#add-site-form button").click();

        const reddit = page.locator('.site-row[data-domain="reddit.com"]');
        await expect(reddit.locator(".site-summary")).toHaveText("Always blocked");
        await expect(page.locator("#add-site-input")).toHaveValue("");

        // And blocking applies immediately
        await page.goto("https://reddit.com/");
        await expect(page.locator("h1")).toHaveText("reddit.com is blocked");
    });

    test("rejects an invalid site with a readable message", async ({ page, extensionId }) => {
        await page.goto(pageUrl(extensionId));

        await page.locator("#add-site-input").fill("not a site");
        await page.locator("#add-site-form button").click();

        await expect(page.locator("#add-site-error")).toHaveText('"not a site" doesn\'t look like a site address');
    });

    test("a schedule edited in the UI is saved, summarized and enforced", async ({ page, serviceWorker, extensionId }) => {
        await blockSite(serviceWorker, "facebook.com");
        await page.goto(pageUrl(extensionId));
        const row = page.locator('.site-row[data-domain="facebook.com"]');

        await row.locator('[aria-label^="Edit schedule"]').click();
        await page.locator('.schedule-editor input[value="custom"]').check();
        const times = page.locator('.schedule-editor input[type="time"]');
        await times.nth(0).fill("01:00");
        await times.nth(1).fill("01:01");
        // The chip's checkbox is visually hidden; users click the chip itself
        await page.locator('.day-chip:has-text("Mon")').click();
        await expect(page.locator('.day-chip input[aria-label="Mon"]')).toBeChecked();
        await page.locator(".schedule-editor button[type=submit]").click();

        await expect(row.locator(".site-summary")).toHaveText("1:00 AM – 1:01 AM on Mon");
        const sites = await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.loadBlockedSites());
        expect(sites[0].schedule).toEqual({ start: "01:00", end: "01:01", days: [1] });

        // One minute on Monday nights: effectively never, so Facebook loads now
        await page.goto("https://www.facebook.com/");
        await expect
            .poll(() => page.url())
            .toBe("https://www.facebook.com/");
    });

    test("the switch disables blocking live and the trash removes the site", async ({ page, serviceWorker, extensionId }) => {
        await blockSite(serviceWorker, "facebook.com");
        await page.goto(pageUrl(extensionId));
        const row = page.locator('.site-row[data-domain="facebook.com"]');

        // The switch's checkbox is visually hidden; users click the slider
        await row.locator(".switch").click();
        await expect(row.locator(".switch input")).not.toBeChecked();
        await expect(row.locator(".site-summary")).toHaveText("Disabled");
        await page.goto("https://www.facebook.com/");
        expect(page.url()).toBe("https://www.facebook.com/");

        await page.goto(pageUrl(extensionId));
        await row.locator(".icon-action.danger").click();
        await expect(page.locator(".site-empty")).toHaveText("No blocked sites. Add one above.");
    });

    test("Shorts & Reels toggles persist across a reload", async ({ page, extensionId }) => {
        await page.goto(pageUrl(extensionId));

        await expect(page.locator("#toggle-shorts")).toBeChecked();
        await page.locator(".toggle-row", { hasText: "Hide YouTube Shorts" }).click();
        await expect(page.locator("#toggle-shorts")).not.toBeChecked();

        await page.reload();
        await expect(page.locator("#toggle-shorts")).not.toBeChecked();
        await expect(page.locator("#toggle-reels")).toBeChecked();
    });

    test("a PIN set here makes the blocked page offer the unblock form; removing it needs a confirmation", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await blockSite(serviceWorker, "facebook.com");
        await page.goto(pageUrl(extensionId));
        await expect(page.locator(".pin-status")).toHaveText("No PIN set: blocked pages don't offer a temporary unblock.");

        await page.locator("#pin-first").fill("1234");
        await page.locator("#pin-second").fill("1234");
        await page.locator("#pin-form button[type=submit]").click();
        await expect(page.locator("#pin-notice")).toHaveText("PIN set");

        await page.goto("https://www.facebook.com/");
        await expect(page.locator("#unblock-form")).toBeVisible();

        await page.goto(pageUrl(extensionId) + "#pin");
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#pin-form .btn-danger").click();
        await expect(page.locator("#pin-notice")).toHaveText("PIN removed");
        await expect(page.locator(".pin-status")).toHaveText(
            "No PIN set: blocked pages don't offer a temporary unblock."
        );
    });

    test("mismatched PIN entries are rejected without saving", async ({ page, serviceWorker, extensionId }) => {
        await page.goto(pageUrl(extensionId));

        await page.locator("#pin-first").fill("1234");
        await page.locator("#pin-second").fill("5678");
        await page.locator("#pin-form button[type=submit]").click();

        await expect(page.locator("#pin-error")).toHaveText("The PINs don't match");
        const settings = await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.loadSettings());
        expect(settings.pinHash).toBeNull();
    });

    test("follows a change made from another context without a reload", async ({ page, serviceWorker, extensionId }) => {
        await page.goto(pageUrl(extensionId));

        await serviceWorker.evaluate(() => globalThis.ATTENTION_SETTINGS.addSite("reddit.com"));

        await expect(page.locator('.site-row[data-domain="reddit.com"]')).toBeVisible();
    });
});
