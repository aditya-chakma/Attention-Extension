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
