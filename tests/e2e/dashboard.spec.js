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
    const seed = (serviceWorker) => serviceWorker.evaluate((data) => chrome.storage.local.set(data), seedData);
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
        await expect(firstVideo.locator("a.card-title")).toHaveAttribute("href", "https://www.youtube.com/watch?v=vidA");
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
        // Only the date it was saved; no video timestamp
        await expect(meta).toHaveText(/^Saved \w+ \d+, \d{4}$/);
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
            const data = await chrome.storage.local.get("attention_bookmarked_videos");
            const videos = JSON.parse(data.attention_bookmarked_videos);
            videos.push({ id: "vidLive", title: "Live added", channel: "Live", time: 1, savedAt: 1900000000000 });
            await chrome.storage.local.set({ attention_bookmarked_videos: JSON.stringify(videos) });
        });

        await expect(page.locator("#content a.card-title")).toHaveText(["Live added", "Second video", "First video"]);

        // And a removal disappears without a reload too
        await serviceWorker.evaluate(() =>
            chrome.storage.local.set({
                attention_bookmarked_videos: JSON.stringify([
                    { id: "vidA", title: "First video", channel: "Channel A", time: 65, savedAt: 1700000000000 },
                ]),
            })
        );
        await expect(page.locator("#content a.card-title")).toHaveText(["First video"]);
    });

    test("deleting a bookmarked video needs no confirmation and can be undone from a bottom-right bar", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await seed(serviceWorker);
        await page.goto(pageUrl(extensionId, "videos.html"));
        const storedIds = () =>
            serviceWorker.evaluate(async () => {
                const data = await chrome.storage.local.get("attention_bookmarked_videos");
                return JSON.parse(data.attention_bookmarked_videos).map((v) => v.id);
            });
        page.on("dialog", () => {
            throw new Error("No confirmation dialog expected");
        });

        await page.locator("#content .card", { hasText: "Second video" }).locator(".delete-btn").click();

        await expect(page.locator("#content a.card-title")).toHaveText(["First video"]);
        await expect.poll(storedIds).toEqual(["vidA"]);

        const bar = page.locator(".undo-bar");
        await expect(bar).toContainText("Video removed");
        const box = await bar.boundingBox();
        const viewport = page.viewportSize();
        expect(box.x + box.width).toBeGreaterThan(viewport.width - 40);
        expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);

        await bar.getByRole("button", { name: "Undo" }).click();
        await expect(bar).toHaveCount(0);
        await expect(page.locator("#content a.card-title")).toHaveText(["Second video", "First video"]);
        await expect.poll(storedIds).toEqual(["vidA", "vidB"]);

        // Left alone, the bar goes away after 5 seconds and the deletion stays
        await page.locator("#content .card", { hasText: "First video" }).locator(".delete-btn").click();
        await expect(bar).toBeVisible();
        await expect(bar).toHaveCount(0, { timeout: 7000 });
        await expect.poll(storedIds).toEqual(["vidB"]);
    });

    test("videos and playlists sit side by side; a playlist can be created, opened, renamed and deleted", async ({
        page,
        serviceWorker,
        extensionId,
    }) => {
        await serviceWorker.evaluate((data) => chrome.storage.local.set(data), {
            ...seedData,
            attention_playlists: JSON.stringify([
                { id: "favorites", name: "Favorites", videoIds: ["vidA"] },
                { id: "watch-later", name: "Watch Later", videoIds: ["vidA"] },
                { id: "pl-old", name: "Old stuff", videoIds: ["vidA", "vidB"] },
            ]),
        });
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(pageUrl(extensionId, "videos.html"));

        // Two columns: videos left, playlists right
        const main = await page.locator("#content .split-main").boundingBox();
        const side = await page.locator("#content .split-side").boundingBox();
        expect(side.x).toBeGreaterThan(main.x + main.width - 1);
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Watch Later", "Old stuff"]);
        await expect(page.locator("#content .segment")).toHaveText(["Recent", "All (2)"]);

        // The defaults can't be renamed or deleted
        for (const name of ["Favorites", "Watch Later"]) {
            await expect(page.getByRole("button", { name: "Delete " + name })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "Rename " + name })).toHaveCount(0);
        }
        await expect(page.locator("#content .default-badge")).toHaveCount(2);

        // Create
        await page.getByRole("button", { name: "New playlist" }).click();
        await page.getByLabel("Playlist name").fill("Lectures");
        await page.getByLabel("Playlist name").press("Enter");
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Watch Later", "Old stuff", "Lectures"]);

        // Rename
        await page.getByRole("button", { name: "Rename Old stuff" }).click();
        await page.getByLabel("Playlist name").fill("Archive");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Watch Later", "Archive", "Lectures"]);

        // Open a playlist page
        await page.locator("#content a.playlist-name", { hasText: "Archive" }).click();
        await expect(page).toHaveURL(pageUrl(extensionId, "playlist.html?id=pl-old"));
        await expect(page.locator("#content .playlist-title")).toHaveText("Archive");
        await expect(page.locator("#content a.card-title")).toHaveText(["Second video", "First video"]);

        // Delete it from its page through the confirmation modal (no browser dialog)
        page.on("dialog", () => {
            throw new Error("The browser's confirm() should not be used");
        });
        await page.getByRole("button", { name: "Delete Archive" }).click();
        const modal = page.getByRole("alertdialog", { name: 'Delete "Archive"?' });
        await expect(modal).toBeVisible();
        await expect(modal).toContainText("1 video that is not in any other playlist");
        await expect(modal.getByRole("button", { name: "Cancel" })).toBeFocused();
        await modal.getByRole("button", { name: "Delete playlist" }).click();

        // vidB was only in this playlist, so its bookmark goes too
        await expect(page).toHaveURL(pageUrl(extensionId, "videos.html"));
        await expect(page.locator("#content .playlist-name")).toHaveText(["Favorites", "Watch Later", "Lectures"]);
        await expect(page.locator("#content a.card-title")).toHaveText(["First video"]);
    });

    test("the All tab pages through videos, 10 per page by default", async ({ page, serviceWorker, extensionId }) => {
        await serviceWorker.evaluate(() => {
            const videos = Array.from({ length: 27 }, (_, i) => ({ id: "v" + i, title: "Video " + i, time: 0, savedAt: 1000 + i }));
            return chrome.storage.local.set({ attention_bookmarked_videos: JSON.stringify(videos) });
        });
        await page.goto(pageUrl(extensionId, "videos.html"));
        await page.getByRole("tab", { name: "All (27)" }).click();

        const pager = page.getByRole("navigation", { name: "Pagination" });
        await expect(page.locator("#content a.card-title")).toHaveCount(10);
        await expect(pager).toContainText("1–10 of 27 videos");

        await pager.getByRole("button", { name: "Next ›" }).click();
        await expect(pager).toContainText("Page 2 of 3");
        await expect(page.locator("#content a.card-title").first()).toHaveText("Video 16");

        await pager.getByLabel("Per page").selectOption("25");
        await expect(page.locator("#content a.card-title")).toHaveCount(25);
        await expect(pager).toContainText("Page 1 of 2");

        // The choice is remembered on the next visit
        await page.reload();
        await page.getByRole("tab", { name: "All (27)" }).click();
        await expect(page.locator("#content a.card-title")).toHaveCount(25);
    });

    test("shows empty states when nothing is bookmarked", async ({ page, extensionId }) => {
        await page.goto(pageUrl(extensionId, "videos.html"));
        await expect(page.locator("#content .empty")).toContainText("No bookmarked videos yet");

        await page.goto(pageUrl(extensionId, "timestamps.html"));
        await expect(page.locator("#content .empty")).toContainText("No bookmarked timestamps yet");
    });
});
