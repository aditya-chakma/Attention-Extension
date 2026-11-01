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

    test("the video bookmark button stores the video with its title and current time", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-save");

        const button = page.locator(".ytp-left-controls img.video-bookmark-btn");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAttribute("title", "Click to bookmark this video");

        await page.evaluate(() => (document.querySelector("video.video-stream").currentTime = 90));
        await button.click();

        await expect
            .poll(async () => {
                const data = await serviceWorker.evaluate(() => chrome.storage.sync.get("attention_bookmarked_videos"));
                return data.attention_bookmarked_videos ? JSON.parse(data.attention_bookmarked_videos) : null;
            })
            .toMatchObject([{ id: "vid-save", title: "Big Buck Bunny", channel: "Blender Foundation", time: 90 }]);
    });

    test("popup explains when the active tab is not a watch page", async ({ page, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/popup.html`);

        await expect(page.locator(".container")).toHaveText("This is not a youtube WATCH video page");
    });

    test("the popup dashboard icon opens the bookmarked videos page in a new tab", async ({
        page,
        context,
        extensionId,
    }) => {
        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        const button = page.locator("#open-dashboard");
        await expect(button).toHaveAttribute("aria-label", "Open bookmarks dashboard");
        await expect(button.locator("svg")).toHaveCount(1);
        await expect(button).toHaveText(""); // icon only, no label text

        const [dashboardPage] = await Promise.all([context.waitForEvent("page"), button.click()]);
        await dashboardPage.waitForLoadState();

        expect(dashboardPage.url()).toBe(`chrome-extension://${extensionId}/videos.html`);
        await expect(dashboardPage.locator(".tab[aria-current='page']")).toHaveText("Bookmarked videos");
    });
});
