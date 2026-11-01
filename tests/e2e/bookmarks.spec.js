import { test, expect } from "./extension.js";

test.describe("YouTube timestamp bookmarks", () => {
    test("bookmark button is added to the player and stores timestamps in sync storage", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/watch?v=e2e-video");

        const button = page.locator(".ytp-left-controls img.bookmark-btn");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAttribute("title", "Click to bookmark current timestamp");
        await expect(button).toHaveAttribute("src", /^chrome-extension:\/\/.+\/assets\/bookmark\.png$/);

        await page.evaluate(() => (document.querySelector("video.video-stream").currentTime = 65));
        await button.click();
        await page.evaluate(() => (document.querySelector("video.video-stream").currentTime = 5));
        await button.click();

        await expect
            .poll(async () => {
                const data = await serviceWorker.evaluate(() => chrome.storage.sync.get("e2e-video"));
                return data["e2e-video"] ? JSON.parse(data["e2e-video"]) : null;
            })
            .toEqual([
                { time: 5, desc: "Bookmark at 00:00:05" },
                { time: 65, desc: "Bookmark at 00:01:05" },
            ]);
    });

    test("popup explains when the active tab is not a watch page", async ({ page, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/popup.html`);

        await expect(page.locator(".container")).toHaveText("This is not a youtube WATCH video page");
    });
});
