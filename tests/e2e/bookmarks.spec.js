import { test, expect } from "./extension.js";

test.describe("YouTube timestamp bookmarks", () => {
    test("bookmark button is added to the player and stores timestamps in sync storage", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/watch?v=e2e-video");

        const button = page.locator(".ytp-left-controls button.bookmark-btn");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAttribute("title", "Click to bookmark current timestamp");
        await expect(button.locator("svg path.ytp-svg-fill")).toHaveCount(1);

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

    const storage = (serviceWorker, key) =>
        serviceWorker.evaluate(async (k) => {
            const data = await chrome.storage.sync.get(k);
            return data[k] ? JSON.parse(data[k]) : null;
        }, key);

    test("the video bookmark button opens a Save to panel and checking a playlist saves the video", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-save");
        const button = page.locator(".ytp-left-controls button.video-bookmark-btn");
        await expect(button).toHaveAttribute("title", "Save this video to a playlist");
        await expect(button).toHaveAttribute("data-saved", "false");

        await page.evaluate(() => (document.querySelector("video.video-stream").currentTime = 90));
        await button.click();

        const dialog = page.getByRole("dialog", { name: "Save to playlist" });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator(".attention-playlist-name")).toHaveText(["Favorites", "Watch Later"]);

        await dialog.getByLabel("Watch Later").check();

        await expect(page.locator(".attention-toast")).toHaveText("Saved to Watch Later");
        await expect(button).toHaveAttribute("data-saved", "true");
        await expect(button.locator("svg")).toHaveAttribute("data-icon", "videoBookmarked");
        await expect
            .poll(() => storage(serviceWorker, "attention_bookmarked_videos"))
            .toMatchObject([{ id: "vid-save", title: "Big Buck Bunny", channel: "Blender Foundation", time: 90 }]);
        const playlists = await storage(serviceWorker, "attention_playlists");
        expect(playlists.find((p) => p.id === "watch-later").videoIds).toEqual(["vid-save"]);
    });

    test("a new playlist can be created from the panel, and the video can be in several playlists", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-multi");
        await page.locator(".video-bookmark-btn").click();
        const dialog = page.getByRole("dialog", { name: "Save to playlist" });

        await dialog.getByLabel("Favorites").check();
        await dialog.getByRole("button", { name: "New playlist" }).click();
        const name = dialog.getByLabel("New playlist name");
        await expect(name).toBeFocused();
        // Typing must not trigger YouTube shortcuts or close the panel
        await name.pressSequentially("Kids films");
        await name.press("Enter");

        // Creating closes the panel with a confirmation
        await expect(page.locator(".attention-toast")).toHaveText('Bookmarked and playlist "Kids films" created');
        await expect(dialog).toHaveCount(0);

        await page.locator(".video-bookmark-btn").click();
        await expect(dialog.getByLabel("Kids films")).toBeChecked();
        await expect(dialog.getByLabel("Favorites")).toBeChecked();
        await expect(dialog.getByRole("button", { name: "Remove from all" })).toBeVisible();

        const playlists = await storage(serviceWorker, "attention_playlists");
        expect(playlists.filter((p) => p.videoIds.includes("vid-multi")).map((p) => p.name)).toEqual([
            "Favorites",
            "Kids films",
        ]);
    });

    test("unchecking the last playlist removes the bookmark; Escape closes the panel", async ({ page, serviceWorker }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-toggle");
        const button = page.locator(".video-bookmark-btn");
        await button.click();
        const dialog = page.getByRole("dialog", { name: "Save to playlist" });

        await dialog.getByLabel("Favorites").check();
        await expect(button).toHaveAttribute("data-saved", "true");
        await dialog.getByLabel("Favorites").uncheck();

        await expect(page.locator(".attention-toast")).toHaveText("Removed from Favorites. Bookmark removed");
        await expect(button).toHaveAttribute("data-saved", "false");
        await expect.poll(() => storage(serviceWorker, "attention_bookmarked_videos")).toEqual([]);

        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
    });

    test("saving a timestamp shows a confirmation toast", async ({ page }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-ts-toast");
        await page.evaluate(() => (document.querySelector("video.video-stream").currentTime = 65));

        const button = page.locator(".attention-player-controls button.bookmark-btn");
        await button.click();
        await expect(page.locator(".attention-toast")).toHaveText("Bookmarked at 00:01:05");
    });

    test("bookmarking the same timestamp twice saves it once and says it is already bookmarked", async ({
        page,
        serviceWorker,
    }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-dup");
        await page.evaluate(() => (document.querySelector("video.video-stream").currentTime = 65));
        const button = page.locator(".attention-player-controls button.bookmark-btn");

        await button.click();
        await expect(page.locator(".attention-toast")).toHaveText("Bookmarked at 00:01:05");
        await button.click();
        await expect(page.locator(".attention-toast")).toHaveText("Already bookmarked at 00:01:05");

        const data = await serviceWorker.evaluate(() => chrome.storage.sync.get("vid-dup"));
        expect(JSON.parse(data["vid-dup"])).toEqual([{ time: 65, desc: "Bookmark at 00:01:05" }]);
    });

    test("in the modern player the buttons sit in a shaded pill aligned with YouTube's controls", async ({ page }) => {
        await page.goto("https://www.youtube.com/watch?v=vid-pill");
        const pill = page.locator(".ytp-left-controls .attention-player-controls");
        await expect(pill.locator("button")).toHaveCount(2);

        // The real player marks itself with these classes; the fixture does not
        await page.evaluate(() => document.getElementById("player").classList.add("ytp-delhi-modern"));

        await expect(pill).toHaveCSS("height", "48px");
        await expect(pill).toHaveCSS("margin-top", "12px");
        await expect(pill).toHaveCSS("border-radius", "28px");
        await expect(pill).toHaveCSS("background-color", "rgba(0, 0, 0, 0.3)");
        await expect(pill.locator(".bookmark-btn svg")).toHaveCSS("filter", "drop-shadow(rgba(0, 0, 0, 0.8) 0px 0px 1px)");
        await expect(pill.locator(".bookmark-btn svg")).toHaveCSS("width", "36px");
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
