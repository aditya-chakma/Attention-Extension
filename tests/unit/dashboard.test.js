import { describe, it, expect, beforeAll } from "vitest";
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
    it("lists videos newest first with thumbnail, channel and link to the saved time", async () => {
        seedStorage();
        await renderPage("videos");

        expect(cardTitles()).toEqual(["Second video", "First video"]);

        const cards = document.querySelectorAll("#content .video-card");
        const first = cards[1]; // vidA
        expect(first.querySelector(".thumb img").src).toBe("https://i.ytimg.com/vi/vidA/mqdefault.jpg");
        expect(first.querySelector(".thumb").href).toBe("https://www.youtube.com/watch?v=vidA&t=65s");
        expect(first.querySelector("a.card-title").href).toBe("https://www.youtube.com/watch?v=vidA&t=65s");
        expect(first.querySelector(".card-channel").textContent).toBe("Channel A");

        expect(cards[0].querySelector("a.card-title").href).toBe("https://www.youtube.com/watch?v=vidB");
    });

    it("shows a short 'time · date' meta line, omitting the time when saved at the start", async () => {
        seedStorage();
        await renderPage("videos");

        const metas = [...document.querySelectorAll("#content .card-meta")].map((m) => m.textContent);
        expect(metas[1]).toMatch(/^00:01:05 · .+\d{4}$/); // vidA, saved at 65s
        expect(metas[1]).not.toContain("Bookmarked at");
        expect(metas[0]).not.toContain("00:00:00"); // vidB, saved at 0s: date only
        expect(metas[0]).toMatch(/\d{4}$/);
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
