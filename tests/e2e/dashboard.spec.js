import { test, expect } from "./extension.js";

const seedData = {
    attention_bookmarked_videos: JSON.stringify([
        { id: "vidA", title: "First video", channel: "Channel A", time: 65, savedAt: 1700000000000 },
        { id: "vidB", title: "Second video", channel: "Channel B", time: 0, savedAt: 1800000000000 },
    ]),
    attention_video_titles: JSON.stringify({ vidA: "First video" }),
    vidA: JSON.stringify([
        { time: 5, desc: "Bookmark at 00:00:05" },
        { time: 65, desc: "Bookmark at 00:01:05" },
    ]),
    vidC: JSON.stringify([{ time: 10, desc: "Bookmark at 00:00:10" }]),
};

test.describe("Bookmarks dashboard", () => {
    const seed = (serviceWorker) => serviceWorker.evaluate((data) => chrome.storage.sync.set(data), seedData);
    const pageUrl = (extensionId, file) => `chrome-extension://${extensionId}/${file}`;

    test("videos page is dark themed and marks its tab as current", async ({ page, serviceWorker, extensionId }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));

        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");
        await expect(page.locator("#tab-videos")).toHaveAttribute("aria-current", "page");
        await expect(page.locator("#tab-timestamps")).not.toHaveAttribute("aria-current", "page");
    });

    test("lists videos newest first with thumbnail, channel and link to the saved time", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));

        await expect(page.locator("#content a.card-title")).toHaveText(["Second video", "First video"]);
        await expect(page.locator("#content .card-channel")).toHaveText(["Channel B", "Channel A"]);

        const firstVideo = page.locator("#content .video-card", { hasText: "First video" });
        await expect(firstVideo.locator("a.card-title")).toHaveAttribute("href", "https://www.youtube.com/watch?v=vidA&t=65s");
        const thumb = firstVideo.locator(".thumb img");
        await expect(thumb).toHaveAttribute("src", "https://i.ytimg.com/vi/vidA/mqdefault.jpg");
        await expect.poll(() => thumb.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    });

    test("the timestamps tab is a separate page grouping bookmarks per video", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));

        await page.click("#tab-timestamps");

        await expect(page).toHaveURL(pageUrl(extensionId, "timestamps.html"));
        await expect(page.locator("#tab-timestamps")).toHaveAttribute("aria-current", "page");
        await expect(page.locator("#content .group-title")).toHaveText(["First video", "vidC"]);
        const firstRow = page.locator("#content .card").first();
        await expect(firstRow.locator(".card-title")).toHaveText("Bookmark at 00:00:05");
        const openLink = firstRow.locator(".open-link");
        await expect(openLink).toHaveText("00:00:05");
        await expect(openLink).toHaveAttribute("title", "Open at 00:00:05");
        await expect(openLink).toHaveAttribute("href", "https://www.youtube.com/watch?v=vidA&t=5s");
    });

    test("timestamp groups show the video thumbnail next to the title only", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "timestamps.html"));

        const header = page.locator("#content .group-header").first();
        const thumb = header.locator("a.thumb-small img");
        await expect(thumb).toHaveAttribute("src", "https://i.ytimg.com/vi/vidA/mqdefault.jpg");
        await expect.poll(() => thumb.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
        await expect(page.locator("#content .card img")).toHaveCount(0);
    });

    test("delete buttons are red icon-only trash buttons and meta lines are short", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));

        const deleteBtn = page.locator("#content .delete-btn").first();
        await expect(deleteBtn).toHaveAttribute("aria-label", "Delete");
        await expect(deleteBtn.locator("svg")).toHaveCount(1);
        await expect(deleteBtn).toHaveText("");
        await expect(deleteBtn).toHaveCSS("color", "rgb(242, 139, 130)");

        const meta = page.locator("#content .video-card", { hasText: "First video" }).locator(".card-meta");
        await expect(meta).toContainText("00:01:05");
        await expect(meta).not.toContainText("Bookmarked at");
    });

    test("clicking the 'Attention' brand goes to the bookmarked videos page", async ({ page, extensionId }) => {
        await page.goto(pageUrl(extensionId, "timestamps.html"));

        const brand = page.locator("header a.brand");
        await expect(brand).toHaveText("Attention");
        await brand.click();

        await expect(page).toHaveURL(pageUrl(extensionId, "videos.html"));
    });

    test("updates in real time when bookmarks change elsewhere", async ({ page, serviceWorker, extensionId }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));
        await expect(page.locator("#content a.card-title")).toHaveText(["Second video", "First video"]);

        // Another context (e.g. the player button in a YouTube tab) adds a video
        await serviceWorker.evaluate(async () => {
            const data = await chrome.storage.sync.get("attention_bookmarked_videos");
            const videos = JSON.parse(data.attention_bookmarked_videos);
            videos.push({ id: "vidLive", title: "Live added", channel: "Live", time: 1, savedAt: 1900000000000 });
            await chrome.storage.sync.set({ attention_bookmarked_videos: JSON.stringify(videos) });
        });

        await expect(page.locator("#content a.card-title")).toHaveText(["Live added", "Second video", "First video"]);

        // And a removal disappears without a reload too
        await serviceWorker.evaluate(() =>
            chrome.storage.sync.set({
                attention_bookmarked_videos: JSON.stringify([
                    { id: "vidA", title: "First video", channel: "Channel A", time: 65, savedAt: 1700000000000 },
                ]),
            })
        );
        await expect(page.locator("#content a.card-title")).toHaveText(["First video"]);
    });

    test("deleting a bookmarked video updates the list and storage", async ({ page, serviceWorker, extensionId }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));

        await page.locator("#content .card", { hasText: "Second video" }).locator(".delete-btn").click();

        await expect(page.locator("#content a.card-title")).toHaveText(["First video"]);
        const stored = await serviceWorker.evaluate(async () => {
            const data = await chrome.storage.sync.get("attention_bookmarked_videos");
            return JSON.parse(data.attention_bookmarked_videos);
        });
        expect(stored.map((v) => v.id)).toEqual(["vidA"]);
    });

    test("videos and playlists sit side by side; a playlist can be created, opened, renamed and deleted", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await serviceWorker.evaluate(
            (data) => chrome.storage.sync.set(data),
            {
                ...seedData,
                attention_playlists: JSON.stringify([
                    { id: "favorites", name: "Favorites", videoIds: ["vidA"] },
                    { id: "watch-later", name: "Watch Later", videoIds: ["vidA", "vidB"] },
                ]),
            }
        );
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(pageUrl(extensionId, "videos.html"));

        // Two columns: videos left, playlists right
        const main = await page.locator("#content .split-main").boundingBox();
        const side = await page.locator("#content .split-side").boundingBox();
        expect(side.x).toBeGreaterThan(main.x + main.width - 1);
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Watch Later"]);
        await expect(page.locator("#content .segment")).toHaveText(["Recent", "All (2)"]);

        // Create
        await page.getByRole("button", { name: "New playlist" }).click();
        await page.getByLabel("Playlist name").fill("Lectures");
        await page.getByLabel("Playlist name").press("Enter");
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Watch Later", "Lectures"]);

        // Rename
        await page.getByRole("button", { name: "Rename Watch Later" }).click();
        await page.getByLabel("Playlist name").fill("Queue");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Queue", "Lectures"]);

        // Open a playlist page
        await page.locator("#content a.playlist-name", { hasText: "Queue" }).click();
        await expect(page).toHaveURL(pageUrl(extensionId, "playlist.html?id=watch-later"));
        await expect(page.locator("#content .playlist-title")).toHaveText("Queue");
        await expect(page.locator("#content a.card-title")).toHaveText(["Second video", "First video"]);

        // Delete it from its page: vidB is only in this playlist, so it goes too
        page.once("dialog", (dialog) => {
            expect(dialog.message()).toContain("1 video that is not in any other playlist");
            dialog.accept();
        });
        await page.getByRole("button", { name: "Delete Queue" }).click();
        await expect(page).toHaveURL(pageUrl(extensionId, "videos.html"));
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Lectures"]);
        await expect(page.locator("#content a.card-title")).toHaveText(["First video"]);
    });

    test("shows empty states when nothing is bookmarked", async ({ page, extensionId }) => {
        await page.goto(pageUrl(extensionId, "videos.html"));
        await expect(page.locator("#content .empty")).toContainText("No bookmarked videos yet");

        await page.goto(pageUrl(extensionId, "timestamps.html"));
        await expect(page.locator("#content .empty")).toContainText("No bookmarked timestamps yet");
    });
});
