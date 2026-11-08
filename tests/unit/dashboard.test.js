import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushPromises } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pageBody = (file) => fs.readFileSync(path.join(root, file), "utf8").match(/<body>([\s\S]*)<\/body>/)[1];
const bodies = { videos: pageBody("videos.html"), timestamps: pageBody("timestamps.html") };

const VIDEOS_KEY = "attention_bookmarked_videos";
const TITLES_KEY = "attention_video_titles";

const seedStorage = () => {
    chrome.__storageData[VIDEOS_KEY] = JSON.stringify([
        { id: "vidA", title: "First video", channel: "Channel A", time: 65, savedAt: 1700000000000 },
        { id: "vidB", title: "Second video", time: 0, savedAt: 1800000000000 },
    ]);
    chrome.__storageData[TITLES_KEY] = JSON.stringify({ vidA: "First video" });
    chrome.__storageData.vidA = JSON.stringify([
        { time: 5, desc: "Bookmark at 00:00:05" },
        { time: 65, desc: "Bookmark at 00:01:05" },
    ]);
    chrome.__storageData.vidC = JSON.stringify([{ time: 10, desc: "Bookmark at 00:00:10" }]);
};

const renderPage = async (page) => {
    document.body.innerHTML = bodies[page];
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flushPromises();
};

const cardTitles = () => [...document.querySelectorAll("#content a.card-title")].map((a) => a.textContent);
const groupTitles = () => [...document.querySelectorAll("#content .group-title")].map((h) => h.textContent);

beforeAll(async () => {
    await import("../../dashboard.js");
});

describe("page chrome (header and navigation)", () => {
    it("shows a clickable 'Attention' brand that leads to the bookmarked videos page", async () => {
        await renderPage("timestamps");

        const brand = document.querySelector("header a.brand");
        expect(brand.textContent.trim()).toBe("Attention");
        expect(brand.getAttribute("href")).toBe("videos.html");
    });

    it("marks the videos tab as current on videos.html", async () => {
        await renderPage("videos");

        expect(document.getElementById("tab-videos").getAttribute("aria-current")).toBe("page");
        expect(document.getElementById("tab-videos").classList.contains("active")).toBe(true);
        expect(document.getElementById("tab-timestamps").hasAttribute("aria-current")).toBe(false);
        expect(document.getElementById("tab-timestamps").getAttribute("href")).toBe("timestamps.html");
    });

    it("marks the timestamps tab as current on timestamps.html", async () => {
        await renderPage("timestamps");

        expect(document.getElementById("tab-timestamps").getAttribute("aria-current")).toBe("page");
        expect(document.getElementById("tab-videos").hasAttribute("aria-current")).toBe(false);
        expect(document.getElementById("tab-videos").getAttribute("href")).toBe("videos.html");
    });
});

describe("bookmarked videos page", () => {
    it("lists videos newest first with thumbnail, channel and a link to the video", async () => {
        seedStorage();
        await renderPage("videos");

        expect(cardTitles()).toEqual(["Second video", "First video"]);

        const cards = document.querySelectorAll("#content .video-card");
        const first = cards[1]; // vidA
        expect(first.querySelector(".thumb img").src).toBe("https://i.ytimg.com/vi/vidA/mqdefault.jpg");
        // The position it was saved at is no longer used
        expect(first.querySelector(".thumb").href).toBe("https://www.youtube.com/watch?v=vidA");
        expect(first.querySelector("a.card-title").href).toBe("https://www.youtube.com/watch?v=vidA");
        expect(first.querySelector(".card-channel").textContent).toBe("Channel A");

        expect(cards[0].querySelector("a.card-title").href).toBe("https://www.youtube.com/watch?v=vidB");
    });

    it("shows only the date the video was saved, not a video timestamp", async () => {
        seedStorage();
        await renderPage("videos");

        const metas = [...document.querySelectorAll("#content .card-meta")].map((m) => m.textContent);
        const date = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
        expect(metas).toEqual(["Saved " + date(1800000000000), "Saved " + date(1700000000000)]);
        expect(metas.join(" ")).not.toMatch(/\d{2}:\d{2}/);
    });

    it("shows titles saved with YouTube's notification count without it", async () => {
        chrome.__storageData[VIDEOS_KEY] = JSON.stringify([{ id: "vidN", title: "(1) Counted", time: 0, savedAt: 1 }]);
        chrome.__storageData[TITLES_KEY] = JSON.stringify({ vidT: "(2) Timestamped" });
        chrome.__storageData.vidT = JSON.stringify([{ time: 1, desc: "Bookmark at 00:00:01" }]);

        await renderPage("videos");
        expect(cardTitles()).toEqual(["Counted"]);

        await renderPage("timestamps");
        expect(groupTitles()).toEqual(["Timestamped"]);
    });

    it("draws the trash and play icons from the central icon registry", async () => {
        seedStorage();
        await renderPage("timestamps");

        const trashSvg = document.querySelector("#content .delete-btn svg");
        const playSvg = document.querySelector("#content .open-link svg");
        const parse = (markup) => new DOMParser().parseFromString(markup, "text/html").body.innerHTML;
        expect(trashSvg.outerHTML).toBe(parse(globalThis.ATTENTION_ICONS.markup.trash));
        expect(playSvg.outerHTML).toBe(parse(globalThis.ATTENTION_ICONS.markup.play));
    });

    it("uses an icon-only red trash button for delete", async () => {
        seedStorage();
        await renderPage("videos");

        const btn = document.querySelector("#content .delete-btn");
        expect(btn.getAttribute("aria-label")).toBe("Delete");
        expect(btn.title).toBe("Delete");
        expect(btn.querySelector("svg")).not.toBeNull();
        expect(btn.textContent.trim()).toBe("");
    });

    it("omits the channel line for entries saved without a channel", async () => {
        seedStorage();
        await renderPage("videos");

        expect(document.querySelectorAll("#content .video-card")[0].querySelector(".card-channel")).toBeNull();
    });

    it("shows an empty state when no videos are bookmarked", async () => {
        await renderPage("videos");

        expect(document.querySelector("#content .empty").textContent).toContain("No bookmarked videos yet");
    });

    it("deleting a video removes it from storage and the list refreshes", async () => {
        seedStorage();
        await renderPage("videos");

        document.querySelector("#content .card .delete-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData[VIDEOS_KEY]).map((v) => v.id)).toEqual(["vidA"]);
        expect(cardTitles()).toEqual(["First video"]);
    });
});

describe("real-time sync", () => {
    it("re-renders when a bookmark is written from another context", async () => {
        seedStorage();
        await renderPage("videos");
        expect(cardTitles()).toEqual(["Second video", "First video"]);

        // Simulate the player button in a YouTube tab writing to sync storage
        chrome.storage.sync.set({
            [VIDEOS_KEY]: JSON.stringify([
                ...JSON.parse(chrome.__storageData[VIDEOS_KEY]),
                { id: "vidNew", title: "Brand new", channel: "C", time: 3, savedAt: 1900000000000 },
            ]),
        });
        await flushPromises();

        expect(cardTitles()).toEqual(["Brand new", "Second video", "First video"]);
    });

    it("updates the timestamps page when a timestamp is added elsewhere", async () => {
        seedStorage();
        await renderPage("timestamps");
        expect(groupTitles()).toEqual(["First video", "vidC"]);

        chrome.storage.sync.set({ vidD: JSON.stringify([{ time: 1, desc: "Bookmark at 00:00:01" }]) });
        await flushPromises();

        expect(groupTitles()).toEqual(["First video", "vidC", "vidD"]);
    });

    it("ignores changes in other storage areas", async () => {
        seedStorage();
        await renderPage("videos");
        const readsBefore = chrome.storage.sync.get.mock.calls.length;

        for (const listener of chrome.__storageChangedListeners) listener({ foo: { newValue: 1 } }, "local");
        await flushPromises();

        expect(chrome.storage.sync.get.mock.calls.length).toBe(readsBefore);
    });

    it("registers a single storage listener for the module", () => {
        expect(chrome.__storageChangedListeners).toHaveLength(1);
    });
});

describe("bookmarked timestamps page", () => {
    it("groups timestamps per video, using known titles and falling back to the id", async () => {
        seedStorage();
        await renderPage("timestamps");

        expect(groupTitles()).toEqual(["First video", "vidC"]);

        const rows = [...document.querySelectorAll("#content .group")[0].querySelectorAll(".card")];
        expect(rows.map((r) => r.querySelector(".card-title").textContent)).toEqual([
            "Bookmark at 00:00:05",
            "Bookmark at 00:01:05",
        ]);
        const openLink = rows[0].querySelector(".open-link");
        expect(openLink.textContent).toBe("00:00:05");
        expect(openLink.title).toBe("Open at 00:00:05");
        expect(openLink.querySelector("svg")).not.toBeNull();
        expect(openLink.href).toBe("https://www.youtube.com/watch?v=vidA&t=5s");
    });

    it("shows one thumbnail per video in the group header, none on individual timestamps", async () => {
        seedStorage();
        await renderPage("timestamps");

        const headers = document.querySelectorAll("#content .group-header");
        expect(headers).toHaveLength(2);
        const thumb = headers[0].querySelector("a.thumb-small");
        expect(thumb.href).toBe("https://www.youtube.com/watch?v=vidA");
        expect(thumb.querySelector("img").src).toBe("https://i.ytimg.com/vi/vidA/mqdefault.jpg");
        expect(headers[0].querySelector(".group-title").textContent).toBe("First video");
        expect(document.querySelectorAll("#content .card img")).toHaveLength(0);
    });

    it("timestamp rows use the icon-only trash button too", async () => {
        seedStorage();
        await renderPage("timestamps");

        const btn = document.querySelector("#content .card .delete-btn");
        expect(btn.getAttribute("aria-label")).toBe("Delete");
        expect(btn.querySelector("svg")).not.toBeNull();
        expect(btn.textContent.trim()).toBe("");
    });

    it("does not treat the reserved dashboard keys as timestamp lists", async () => {
        seedStorage();
        await renderPage("timestamps");

        expect(groupTitles()).not.toContain(VIDEOS_KEY);
        expect(groupTitles()).not.toContain(TITLES_KEY);
    });

    it("shows an empty state when no timestamps are bookmarked", async () => {
        await renderPage("timestamps");

        expect(document.querySelector("#content .empty").textContent).toContain("No bookmarked timestamps yet");
    });

    it("deleting a timestamp updates storage and drops an emptied group", async () => {
        seedStorage();
        await renderPage("timestamps");

        document.querySelectorAll("#content .group")[1].querySelector(".delete-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData.vidC)).toEqual([]);
        expect(groupTitles()).toEqual(["First video"]);
    });

    it("renders malicious titles and channel names as plain text", async () => {
        chrome.__storageData[VIDEOS_KEY] = JSON.stringify([
            { id: "vidX", title: "<b>bold</b>", channel: '<img src=x onerror="window.__pwned=1">', time: 1, savedAt: 1 },
        ]);
        await renderPage("videos");

        expect(document.querySelector("#content .card-title").textContent).toBe("<b>bold</b>");
        expect(document.querySelector("#content .card-title b")).toBeNull();
        expect(document.querySelector("#content .card-channel img")).toBeNull();
        expect(window.__pwned).toBeUndefined();
    });
});

// ---- Playlists

const PLAYLISTS_KEY = "attention_playlists";
bodies.playlist = pageBody("playlist.html");

const storedPlaylists = () => JSON.parse(chrome.__storageData[PLAYLISTS_KEY]);
const playlistNames = () => [...document.querySelectorAll("#content .playlist-row .playlist-name")].map((n) => n.textContent);
const playlistRow = (id) => document.querySelector(`#content .playlist-row[data-playlist-id="${id}"]`);
const settle = async () => {
    for (let i = 0; i < 4; i++) await flushPromises();
};

const seedPlaylists = () => {
    seedStorage(); // vidA, vidB bookmarked
    chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
        { id: "favorites", name: "Favorites", videoIds: ["vidA", "vidB"] },
        { id: "watch-later", name: "Watch Later", videoIds: ["vidB"] },
    ]);
};

const seedManyVideos = (count, extra = {}) => {
    const videos = Array.from({ length: count }, (_, i) => ({ id: "v" + i, title: "Video " + i, time: 0, savedAt: 1000 + i }));
    chrome.__storageData[VIDEOS_KEY] = JSON.stringify(videos);
    for (const [key, value] of Object.entries(extra)) chrome.__storageData[key] = value;
    return videos;
};

const pagerText = () => ({
    range: document.querySelector("#content .pager-range")?.textContent,
    status: document.querySelector("#content .pager-status")?.textContent,
});

const showView = async (view) => {
    document.querySelector(`#content .segment[data-view="${view}"]`).click();
    await settle();
};

const setPageSize = async (size) => {
    const select = document.querySelector("#content .pager-size select");
    select.value = String(size);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
};

const typeInto = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("bookmarked videos page layout", () => {
    it("splits the page into videos on the left and playlists on the right", async () => {
        seedPlaylists();
        await renderPage("videos");

        const split = document.querySelector("#content .split");
        expect(split.children).toHaveLength(2);
        expect(split.children[0].matches(".split-main")).toBe(true);
        expect(split.children[0].querySelector(".video-card")).not.toBeNull();
        expect(split.children[1].matches(".split-side")).toBe(true);
        expect(split.children[1].querySelector(".playlist-row")).not.toBeNull();
    });

    it("shows the default playlists when none were saved yet", async () => {
        await renderPage("videos");

        expect(playlistNames()).toEqual(["Favorites", "Watch Later"]);
        expect(playlistRow("favorites").querySelector(".playlist-count").textContent).toBe("0 videos");
    });

    it("each playlist links to its own page and shows its size and latest video thumbnail", async () => {
        seedPlaylists();
        await renderPage("videos");

        const row = playlistRow("favorites");
        expect(row.querySelector("a.playlist-name").getAttribute("href")).toBe("playlist.html?id=favorites");
        expect(row.querySelector(".playlist-count").textContent).toBe("2 videos");
        expect(row.querySelector(".playlist-thumb img").src).toBe("https://i.ytimg.com/vi/vidB/mqdefault.jpg");
        expect(playlistRow("watch-later").querySelector(".playlist-count").textContent).toBe("1 video");
    });

    it("video cards show which playlists they are in", async () => {
        seedPlaylists();
        await renderPage("videos");

        const chips = (title) =>
            [...[...document.querySelectorAll("#content .video-card")]
                .find((c) => c.querySelector(".card-title").textContent === title)
                .querySelectorAll(".chip")].map((c) => c.textContent);
        expect(chips("Second video")).toEqual(["Favorites", "Watch Later"]);
        expect(chips("First video")).toEqual(["Favorites"]);
    });

    it("Recent shows the 10 newest videos without paging; All pages through every video", async () => {
        seedManyVideos(12);
        await renderPage("videos");

        const tabs = [...document.querySelectorAll("#content .segment")];
        expect(tabs.map((t) => t.textContent)).toEqual(["Recent", "All (12)"]);
        expect(tabs[0].getAttribute("aria-selected")).toBe("true");
        expect(cardTitles()).toHaveLength(10);
        expect(cardTitles()[0]).toBe("Video 11");
        expect(document.querySelector("#content .pager")).toBeNull();

        document.querySelector("#content .link-btn").click(); // "Show all 12 videos"
        await settle();

        expect(document.querySelector('#content .segment[data-view="all"]').getAttribute("aria-selected")).toBe("true");
        expect(cardTitles()).toHaveLength(10);
        expect(pagerText()).toEqual({ range: "1–10 of 12 videos", status: "Page 1 of 2" });

        await showView("recent");
    });

    it("deleting a video from the left list also takes it out of its playlists", async () => {
        seedPlaylists();
        await renderPage("videos");

        [...document.querySelectorAll("#content .video-card")]
            .find((c) => c.querySelector(".card-title").textContent === "Second video")
            .querySelector(".delete-btn")
            .click();
        await settle();

        expect(JSON.parse(chrome.__storageData[VIDEOS_KEY]).map((v) => v.id)).toEqual(["vidA"]);
        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([["vidA"], []]);
    });
});

describe("managing playlists on the dashboard", () => {
    it("creates a playlist with the inline form", async () => {
        await renderPage("videos");

        document.querySelector("#content .new-playlist-btn").click();
        await settle();
        const input = document.querySelector("#content .split-side .inline-form input");
        expect(document.activeElement).toBe(input);
        const submit = document.querySelector("#content .inline-form button[type=submit]");
        expect(submit.disabled).toBe(true);

        typeInto(input, "Lectures");
        expect(submit.disabled).toBe(false);
        input.form.requestSubmit();
        await settle();

        expect(playlistNames()).toEqual(["Favorites", "Watch Later", "Lectures"]);
        expect(document.querySelector("#content .inline-form")).toBeNull();
    });

    it("shows the validation error and keeps the form open for a duplicate name", async () => {
        await renderPage("videos");

        document.querySelector("#content .new-playlist-btn").click();
        await settle();
        typeInto(document.querySelector("#content .inline-form input"), "Watch later");
        document.querySelector("#content .inline-form").requestSubmit();
        await settle();

        expect(document.querySelector("#content .form-error").textContent).toBe('A playlist named "Watch later" already exists');
        expect(document.querySelector("#content .inline-form input").value).toBe("Watch later");
        expect(playlistNames()).toEqual(["Favorites", "Watch Later"]);
    });

    it("Escape cancels the form", async () => {
        await renderPage("videos");

        document.querySelector("#content .new-playlist-btn").click();
        await settle();
        document
            .querySelector("#content .inline-form input")
            .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();

        expect(document.querySelector("#content .inline-form")).toBeNull();
    });

    it("renames a custom playlist in place", async () => {
        seedPlaylists();
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
            ...JSON.parse(chrome.__storageData[PLAYLISTS_KEY]),
            { id: "pl-mine", name: "Mine", videoIds: ["vidB"] },
        ]);
        await renderPage("videos");

        playlistRow("pl-mine").querySelector(".rename-btn").click();
        await settle();
        const input = playlistRow("pl-mine").querySelector(".inline-form input");
        expect(input.value).toBe("Mine");

        typeInto(input, "Queue");
        input.form.requestSubmit();
        await settle();

        expect(playlistNames()).toEqual(["Favorites", "Watch Later", "Queue"]);
        expect(storedPlaylists()[2]).toEqual({ id: "pl-mine", name: "Queue", videoIds: ["vidB"] });
    });

    it("an open form survives a re-render caused by changes elsewhere", async () => {
        seedPlaylists();
        await renderPage("videos");
        document.querySelector("#content .new-playlist-btn").click();
        await settle();
        typeInto(document.querySelector("#content .inline-form input"), "Half typed");

        // e.g. a video saved from a YouTube tab
        chrome.storage.sync.set({ attention_video_titles: JSON.stringify({}) });
        await settle();

        const input = document.querySelector("#content .inline-form input");
        expect(input.value).toBe("Half typed");
        expect(document.activeElement).toBe(input);
    });

    const seedCustomPlaylist = () => {
        seedStorage(); // vidA, vidB bookmarked
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
            { id: "favorites", name: "Favorites", videoIds: ["vidB"] },
            { id: "watch-later", name: "Watch Later", videoIds: [] },
            { id: "pl-old", name: "Old stuff", videoIds: ["vidA", "vidB"] },
        ]);
    };
    const modal = () => document.querySelector(".modal-backdrop .modal");

    it("Favorites and Watch Later have neither rename nor delete, just a Default badge; other playlists have both", async () => {
        seedCustomPlaylist();
        await renderPage("videos");

        for (const id of ["favorites", "watch-later"]) {
            expect(playlistRow(id).querySelector(".rename-btn")).toBeNull();
            expect(playlistRow(id).querySelector(".delete-playlist-btn")).toBeNull();
            expect(playlistRow(id).querySelector(".default-badge").textContent).toBe("Default");
        }
        expect(playlistRow("pl-old").querySelector(".rename-btn")).not.toBeNull();
        expect(playlistRow("pl-old").querySelector(".delete-playlist-btn")).not.toBeNull();
        expect(playlistRow("pl-old").querySelector(".default-badge")).toBeNull();
    });

    it("deleting a playlist opens a confirmation modal instead of the browser's confirm()", async () => {
        seedCustomPlaylist();
        await renderPage("videos");
        const browserConfirm = vi.spyOn(window, "confirm");

        playlistRow("pl-old").querySelector(".delete-playlist-btn").click();
        await settle();

        expect(browserConfirm).not.toHaveBeenCalled();
        expect(modal().getAttribute("role")).toBe("alertdialog");
        expect(modal().getAttribute("aria-modal")).toBe("true");
        expect(modal().querySelector(".modal-title").textContent).toBe('Delete "Old stuff"?');
        // vidA is only in this playlist; vidB is also in Favorites
        expect([...modal().querySelectorAll(".modal-message p")].map((p) => p.textContent)).toEqual([
            "The playlist will be deleted. This can't be undone.",
            "1 video that is not in any other playlist will also be removed from your bookmarks.",
        ]);
        expect(document.activeElement.textContent).toBe("Cancel"); // safe default
        // Nothing is deleted until confirmed
        expect(playlistNames()).toEqual(["Favorites", "Watch Later", "Old stuff"]);

        modal().querySelector(".btn-danger").click();
        await settle();

        expect(modal()).toBeNull();
        expect(playlistNames()).toEqual(["Favorites", "Watch Later"]);
        expect(JSON.parse(chrome.__storageData[VIDEOS_KEY]).map((v) => v.id)).toEqual(["vidB"]);
        browserConfirm.mockRestore();
    });

    it("omits the warning when every video is also in another playlist", async () => {
        seedCustomPlaylist();
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
            { id: "favorites", name: "Favorites", videoIds: ["vidA", "vidB"] },
            { id: "pl-old", name: "Old stuff", videoIds: ["vidA"] },
        ]);
        await renderPage("videos");

        playlistRow("pl-old").querySelector(".delete-playlist-btn").click();
        await settle();

        expect(modal().querySelectorAll(".modal-message p")).toHaveLength(1);
        modal().querySelector(".btn").click(); // Cancel
        await settle();
    });

    it.each([
        ["Cancel", () => modal().querySelector(".modal-actions .btn:not(.btn-danger)").click()],
        ["Escape", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
        ["a click on the backdrop", () => document.querySelector(".modal-backdrop").click()],
    ])("%s keeps the playlist", async (_, dismiss) => {
        seedCustomPlaylist();
        await renderPage("videos");
        const trigger = playlistRow("pl-old").querySelector(".delete-playlist-btn");
        trigger.focus();
        trigger.click();
        await settle();

        dismiss();
        await settle();

        expect(modal()).toBeNull();
        expect(playlistNames()).toEqual(["Favorites", "Watch Later", "Old stuff"]);
        expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("a click inside the modal does not dismiss it, and Tab keeps focus inside", async () => {
        seedCustomPlaylist();
        await renderPage("videos");
        playlistRow("pl-old").querySelector(".delete-playlist-btn").click();
        await settle();

        modal().querySelector(".modal-title").click();
        expect(modal()).not.toBeNull();

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(document.activeElement.textContent).toBe("Delete playlist");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(document.activeElement.textContent).toBe("Cancel");

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
    });

    it("renders malicious playlist names as plain text", async () => {
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
            { id: "x", name: '<img src=x onerror="window.__pwnedPl=1">', videoIds: [] },
        ]);
        await renderPage("videos");

        expect(playlistNames()).toEqual(["Favorites", "Watch Later", '<img src=x onerror="window.__pwnedPl=1">']);
        expect(document.querySelector("#content .playlist-info img")).toBeNull();
        expect(window.__pwnedPl).toBeUndefined();
    });
});

describe("playlist page", () => {
    const openPlaylistPage = async (id) => {
        window.history.replaceState({}, "", "/playlist.html?id=" + encodeURIComponent(id));
        await renderPage("playlist");
    };

    it("shows the playlist's videos, newest additions first", async () => {
        seedPlaylists();
        await openPlaylistPage("favorites");

        expect(document.querySelector("#content .playlist-title").textContent).toBe("Favorites");
        expect(document.querySelector("#content .playlist-count").textContent).toBe("2 videos");
        expect(cardTitles()).toEqual(["Second video", "First video"]);
        expect(document.title).toBe("Attention — Favorites");
        expect(document.querySelector("#content .back-link").getAttribute("href")).toBe("videos.html");
    });

    it("keeps the videos tab highlighted", async () => {
        await openPlaylistPage("favorites");

        expect(document.getElementById("tab-videos").classList.contains("active")).toBe(true);
    });

    it("the delete button removes the video from this playlist only", async () => {
        seedPlaylists();
        await openPlaylistPage("watch-later");

        const btn = document.querySelector("#content .video-card .delete-btn");
        expect(btn.getAttribute("aria-label")).toBe("Remove from playlist");
        btn.click();
        await settle();

        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([["vidA", "vidB"], []]);
        // Still in Favorites, so still bookmarked
        expect(JSON.parse(chrome.__storageData[VIDEOS_KEY]).map((v) => v.id)).toEqual(["vidA", "vidB"]);
        expect(document.querySelector("#content .empty").textContent).toContain("No videos in this playlist yet");
    });

    it("can rename a custom playlist from its page", async () => {
        seedPlaylists();
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
            ...JSON.parse(chrome.__storageData[PLAYLISTS_KEY]),
            { id: "pl-mine", name: "Mine", videoIds: [] },
        ]);
        await openPlaylistPage("pl-mine");

        document.querySelector("#content .playlist-header .rename-btn").click();
        await settle();
        const input = document.querySelector("#content .playlist-header .inline-form input");
        typeInto(input, "Best of");
        input.form.requestSubmit();
        await settle();

        expect(document.querySelector("#content .playlist-title").textContent).toBe("Best of");
    });

    it("a default playlist's page has no rename or delete, but its videos can still be removed", async () => {
        seedPlaylists();
        await openPlaylistPage("favorites");

        expect(document.querySelector("#content .playlist-header .rename-btn")).toBeNull();
        expect(document.querySelector("#content .playlist-header .delete-playlist-btn")).toBeNull();
        expect(document.querySelector("#content .playlist-header .default-badge")).not.toBeNull();
        expect(document.querySelectorAll("#content .video-card .delete-btn")).toHaveLength(2);
    });

    it("explains when the playlist does not exist", async () => {
        await openPlaylistPage("nope");

        expect(document.querySelector("#content .empty").textContent).toBe("This playlist doesn't exist anymore.");
        expect(document.querySelector("#content .back-link")).not.toBeNull();
    });
});

describe("pagination", () => {
    const openPlaylistPage = async (id) => {
        window.history.replaceState({}, "", "/playlist.html?id=" + encodeURIComponent(id));
        await renderPage("playlist");
    };
    const clickPager = async (which) => {
        document.querySelector(`#content .pager-${which}`).click();
        await settle();
    };

    afterEach(async () => {
        // Page size, page numbers and the Recent/All choice are page-level UI
        // state; put them back so tests don't leak into each other
        window.localStorage.clear();
        if (document.querySelector("#content .pager-size select")) await setPageSize(10);
        if (document.querySelector('#content .segment[data-view="recent"]')) await showView("recent");
    });

    it("shows 10 per page by default and steps through pages with Previous/Next", async () => {
        seedManyVideos(23);
        await renderPage("videos");
        await showView("all");

        expect(cardTitles()).toHaveLength(10);
        expect(cardTitles()[0]).toBe("Video 22");
        expect(pagerText()).toEqual({ range: "1–10 of 23 videos", status: "Page 1 of 3" });
        expect(document.querySelector("#content .pager-prev").disabled).toBe(true);

        await clickPager("next");
        expect(cardTitles()[0]).toBe("Video 12");
        expect(pagerText()).toEqual({ range: "11–20 of 23 videos", status: "Page 2 of 3" });

        await clickPager("next");
        expect(cardTitles()).toEqual(["Video 2", "Video 1", "Video 0"]);
        expect(pagerText().range).toBe("21–23 of 23 videos");
        expect(document.querySelector("#content .pager-next").disabled).toBe(true);

        await clickPager("prev");
        expect(pagerText().status).toBe("Page 2 of 3");
    });

    it("offers 10, 15 and 25 per page, starts over at page 1 and remembers the choice", async () => {
        seedManyVideos(30);
        await renderPage("videos");
        await showView("all");
        await clickPager("next");

        const options = [...document.querySelectorAll("#content .pager-size option")].map((o) => o.value);
        expect(options).toEqual(["10", "15", "25"]);
        expect(document.querySelector("#content .pager-size select").value).toBe("10");

        await setPageSize(25);

        expect(cardTitles()).toHaveLength(25);
        expect(pagerText()).toEqual({ range: "1–25 of 30 videos", status: "Page 1 of 2" });
        expect(window.localStorage.getItem("attention.pageSize")).toBe("25");

        await setPageSize(15);
        expect(cardTitles()).toHaveLength(15);
        expect(pagerText().status).toBe("Page 1 of 2");
    });

    it("hides the pager when everything fits on the smallest page", async () => {
        seedManyVideos(10);
        await renderPage("videos");
        await showView("all");

        expect(cardTitles()).toHaveLength(10);
        expect(document.querySelector("#content .pager")).toBeNull();
    });

    it("moves back a page when deleting the last video on the last page", async () => {
        seedManyVideos(11);
        await renderPage("videos");
        await showView("all");
        await clickPager("next");
        expect(cardTitles()).toEqual(["Video 0"]);

        document.querySelector("#content .video-card .delete-btn").click();
        await settle();

        expect(cardTitles()).toHaveLength(10);
        expect(document.querySelector("#content .pager")).toBeNull();
    });

    it("pages a playlist's videos", async () => {
        const videos = seedManyVideos(12);
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify([
            { id: "favorites", name: "Favorites", videoIds: videos.map((v) => v.id) },
        ]);
        await openPlaylistPage("favorites");

        expect(cardTitles()).toHaveLength(10);
        expect(pagerText()).toEqual({ range: "1–10 of 12 videos", status: "Page 1 of 2" });
        await clickPager("next");
        expect(cardTitles()).toEqual(["Video 1", "Video 0"]);
    });

    it("pages the timestamps page by video", async () => {
        chrome.__storageData[VIDEOS_KEY] = JSON.stringify([]);
        for (let i = 0; i < 12; i++) {
            chrome.__storageData["ts" + i] = JSON.stringify([{ time: i, desc: "Bookmark at " + i }]);
        }
        await renderPage("timestamps");

        expect(groupTitles()).toHaveLength(10);
        expect(pagerText()).toEqual({ range: "1–10 of 12 videos", status: "Page 1 of 2" });
        await clickPager("next");
        expect(groupTitles()).toEqual(["ts10", "ts11"]);
    });
});

describe("undo after deleting a video", () => {
    const undoBar = () => document.querySelector(".undo-bar");
    const deleteCard = async (title) => {
        [...document.querySelectorAll("#content .video-card")]
            .find((c) => c.querySelector(".card-title").textContent === title)
            .querySelector(".delete-btn")
            .click();
        await settle();
    };

    it("deletes immediately (no confirmation) and offers Undo, which restores the video and its playlists", async () => {
        seedPlaylists(); // vidB is in Favorites and Watch Later
        const before = { videos: chrome.__storageData[VIDEOS_KEY], playlists: chrome.__storageData[PLAYLISTS_KEY] };
        await renderPage("videos");
        const browserConfirm = vi.spyOn(window, "confirm");

        await deleteCard("Second video");

        expect(browserConfirm).not.toHaveBeenCalled();
        expect(document.querySelector(".modal-backdrop")).toBeNull();
        expect(cardTitles()).toEqual(["First video"]);
        expect(undoBar().getAttribute("role")).toBe("status");
        expect(undoBar().querySelector(".undo-message").textContent).toBe("Video removed");

        undoBar().querySelector(".undo-btn").click();
        await settle();

        expect(undoBar()).toBeNull();
        expect(cardTitles()).toEqual(["Second video", "First video"]);
        expect(chrome.__storageData[VIDEOS_KEY]).toBe(before.videos);
        expect(chrome.__storageData[PLAYLISTS_KEY]).toBe(before.playlists);
        browserConfirm.mockRestore();
    });

    it("the Undo bar disappears after 5 seconds and the deletion stays", async () => {
        seedStorage();
        await renderPage("videos");
        vi.useFakeTimers();
        try {
            document.querySelector("#content .video-card .delete-btn").click();
            await vi.advanceTimersByTimeAsync(4900);
            expect(undoBar()).not.toBeNull();

            await vi.advanceTimersByTimeAsync(200);
            expect(undoBar()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
        expect(JSON.parse(chrome.__storageData[VIDEOS_KEY]).map((v) => v.id)).toEqual(["vidA"]);
    });

    it("a second deletion replaces the bar; Undo restores only the latest one", async () => {
        seedStorage();
        await renderPage("videos");

        await deleteCard("Second video");
        await deleteCard("First video");

        expect(document.querySelectorAll(".undo-bar")).toHaveLength(1);
        undoBar().querySelector(".undo-btn").click();
        await settle();

        expect(cardTitles()).toEqual(["First video"]);
    });

    it("removing from a playlist page can be undone too", async () => {
        seedPlaylists();
        window.history.replaceState({}, "", "/playlist.html?id=watch-later");
        await renderPage("playlist");

        document.querySelector("#content .video-card .delete-btn").click();
        await settle();
        expect(undoBar().querySelector(".undo-message").textContent).toBe("Removed from Watch Later");

        undoBar().querySelector(".undo-btn").click();
        await settle();

        expect(storedPlaylists().find((p) => p.id === "watch-later").videoIds).toEqual(["vidB"]);
        expect(cardTitles()).toEqual(["Second video"]);
    });
});
