import { test, expect } from "./extension.js";

test.describe("YouTube Shorts removal", () => {
    test("home page: Shorts shelves are removed, other content stays", async ({ page }) => {
        await page.goto("https://www.youtube.com/");

        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);
        await expect(page.locator("ytd-rich-item-renderer")).toHaveCount(2);
        await expect(page.locator("ytd-rich-item-renderer").first()).toBeVisible();
    });

    test("home page: reel shelf is hidden by CSS but not removed", async ({ page }) => {
        await page.goto("https://www.youtube.com/");

        const reel = page.locator("#reel-on-home");
        await expect(reel).toHaveCount(1);
        await expect(reel).toBeHidden();
        await expect(reel).toHaveCSS("display", "none");
    });

    test("home page: shelves injected by infinite scroll are removed and never visible", async ({ page }) => {
        await page.goto("https://www.youtube.com/");
        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);

        const wasVisibleOnInsert = await page.evaluate(() => {
            const shelf = document.createElement("ytd-rich-section-renderer");
            shelf.textContent = "Late shelf";
            document.getElementById("feed").append(shelf);
            // Synchronously after insertion the node exists but hide.css already hides it
            return getComputedStyle(shelf).display !== "none";
        });

        expect(wasVisibleOnInsert).toBe(false);
        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);
    });

    test("watch page: reel shelves are removed, rich section is only hidden", async ({ page }) => {
        await page.goto("https://www.youtube.com/watch?v=abc123");

        await expect(page.locator("ytd-reel-shelf-renderer")).toHaveCount(0);
        await expect(page.locator("ytd-compact-video-renderer")).toBeVisible();

        const rich = page.locator("#rich-on-watch");
        await expect(rich).toHaveCount(1);
        await expect(rich).toBeHidden();
    });

    test("SPA navigation: yt-navigate-finish switches which selector is removed", async ({ page }) => {
        await page.goto("https://www.youtube.com/");
        await expect(page.locator("#reel-on-home")).toHaveCount(1);

        await page.evaluate(() => {
            history.pushState({}, "", "/watch?v=spa-video");
            document.dispatchEvent(new Event("yt-navigate-finish"));
        });

        await expect(page.locator("ytd-reel-shelf-renderer")).toHaveCount(0);

        // Going back home switches back to removing rich sections
        await page.evaluate(() => {
            history.pushState({}, "", "/");
            document.dispatchEvent(new Event("yt-navigate-finish"));
            const shelf = document.createElement("ytd-rich-section-renderer");
            document.getElementById("feed").append(shelf);
        });
        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);
    });
});

test.describe("Shorts & Reels toggles", () => {
    const setToggle = (serviceWorker, toggle, hidden) =>
        serviceWorker.evaluate(([t, h]) => globalThis.ATTENTION_SETTINGS.setHideToggle(t, h), [toggle, hidden]);

    test("with 'Hide YouTube Shorts' off the shelves stay visible, and come back when it is on again", async ({
        page,
        serviceWorker,
    }) => {
        await setToggle(serviceWorker, "youtubeShorts", false);
        await page.goto("https://www.youtube.com/");

        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(2);
        await expect(page.locator("ytd-rich-section-renderer").first()).toBeVisible();
        await expect(page.locator("#reel-on-home")).toBeVisible();

        // Flipping it on applies to the open tab without a reload
        await setToggle(serviceWorker, "youtubeShorts", true);
        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);
        await expect(page.locator("#reel-on-home")).toBeHidden();
    });

    test("Facebook Reels are removed by default and shown when 'Hide Facebook Reels' is off", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.facebook.com/");
        await expect(page.locator('[aria-label="Reels"]')).toHaveCount(0);

        await setToggle(serviceWorker, "facebookReels", false);
        await page.reload();
        await expect(page.locator('[aria-label="Reels"]')).toBeVisible();
    });

    test("the toggles are independent: Reels off leaves Shorts hidden", async ({ page, serviceWorker }) => {
        await setToggle(serviceWorker, "facebookReels", false);
        await page.goto("https://www.youtube.com/");

        await expect(page.locator("ytd-rich-section-renderer")).toHaveCount(0);
    });
});
