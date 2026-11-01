/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.youtube.com/" }
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { flushRemoval, flushPromises } from "./helpers.js";

const richSection = () => document.createElement("ytd-rich-section-renderer");
const reelShelf = () => document.createElement("ytd-reel-shelf-renderer");

const goTo = (path) => {
    window.history.replaceState({}, "", path);
    document.dispatchEvent(new Event("yt-navigate-finish"));
};

let onMessage;
let logSpy;
let atLoad; // snapshot taken right after the script ran, before any per-test mock reset

beforeAll(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Elements present before the script runs must be removed on load
    document.body.append(richSection(), richSection(), reelShelf());

    await import("../../contentScript.js");
    onMessage = chrome.__messageListeners[0];

    atLoad = {
        richSections: document.querySelectorAll("ytd-rich-section-renderer").length,
        reelShelves: document.querySelectorAll("ytd-reel-shelf-renderer").length,
        logs: logSpy.mock.calls.map(([message]) => message),
        getURLCalls: chrome.runtime.getURL.mock.calls.map(([path]) => path),
    };
});

afterEach(() => {
    document.body.innerHTML = "";
    logSpy.mockClear();
    goTo("/"); // back to home mode for the next test
});

describe("YouTube home page", () => {
    it("removes rich sections present at load but leaves reel shelves alone", () => {
        expect(atLoad.richSections).toBe(0);
        expect(atLoad.reelShelves).toBe(1);
        expect(atLoad.logs).toContain("Attention extension has removed 2 shorts from yt-home");
    });

    it("does not redirect YouTube to the blocked page", () => {
        expect(atLoad.getURLCalls).not.toContain("blocked.html");
    });

    it("removes rich sections inserted later (infinite scroll)", async () => {
        document.body.append(richSection());
        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(1);

        await flushRemoval();

        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(0);
    });

    it("removes rich sections nested inside inserted subtrees", async () => {
        const wrapper = document.createElement("div");
        wrapper.append(richSection(), richSection(), richSection());
        document.body.append(wrapper);

        await flushRemoval();

        expect(wrapper.children).toHaveLength(0);
        expect(logSpy).toHaveBeenCalledWith("Attention extension has removed 3 shorts from yt-home");
    });

    it("coalesces a burst of mutations into a single sweep", async () => {
        for (let i = 0; i < 10; i++) document.body.append(richSection());

        await flushRemoval();

        const removalLogs = logSpy.mock.calls.filter(([m]) => String(m).startsWith("Attention extension has removed"));
        expect(removalLogs).toHaveLength(1);
        expect(removalLogs[0][0]).toBe("Attention extension has removed 10 shorts from yt-home");
    });

    it("does nothing (and logs nothing) when unrelated nodes are added", async () => {
        document.body.append(document.createElement("div"));

        await flushRemoval();

        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe("YouTube SPA navigation (yt-navigate-finish)", () => {
    it("switches to removing reel shelves on a watch page", async () => {
        document.body.append(reelShelf(), richSection());

        goTo("/watch?v=abc123");

        // The switch sweeps synchronously
        expect(document.querySelectorAll("ytd-reel-shelf-renderer")).toHaveLength(0);
        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(1);
        expect(logSpy).toHaveBeenCalledWith("Attention extension has removed 1 shorts from yt-watch");
    });

    it("keeps removing reel shelves added later on the watch page", async () => {
        goTo("/watch?v=abc123");
        document.body.append(reelShelf());

        await flushRemoval();

        expect(document.querySelectorAll("ytd-reel-shelf-renderer")).toHaveLength(0);
    });

    it("switches back to rich sections when navigating home", async () => {
        goTo("/watch?v=abc123");
        goTo("/");
        document.body.append(richSection(), reelShelf());

        await flushRemoval();

        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(0);
        expect(document.querySelectorAll("ytd-reel-shelf-renderer")).toHaveLength(1);
    });
});

describe("background messages", () => {
    it("registers a single onMessage listener", () => {
        expect(chrome.__messageListeners).toHaveLength(1);
    });

    it("yt-watch message switches the removal selector", () => {
        document.body.append(reelShelf());

        const isAsync = onMessage({ source: "yt-watch", type: "NEW", videoId: "vid1" }, {}, () => {});

        expect(isAsync).toBe(false);
        expect(document.querySelectorAll("ytd-reel-shelf-renderer")).toHaveLength(0);
    });

    it("yt-home message switches the removal selector", () => {
        onMessage({ source: "yt-watch", type: "NEW", videoId: "vid1" }, {}, () => {});
        document.body.append(richSection());

        onMessage({ source: "yt-home" }, {}, () => {});

        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(0);
    });

    it("ignores messages with an unknown source", () => {
        document.body.append(richSection());
        expect(() => onMessage({ source: "something-else" }, {}, () => {})).not.toThrow();
    });
});

describe("bookmarks on a watch page", () => {
    const setupPlayer = () => {
        const controls = document.createElement("div");
        controls.className = "ytp-left-controls";
        const video = document.createElement("video");
        video.className = "video-stream";
        document.body.append(controls, video);
        return { controls, video };
    };

    const loadVideo = async (videoId) => {
        onMessage({ source: "yt-watch", type: "NEW", videoId }, {}, () => {});
        await flushPromises();
    };

    it("adds a bookmark button to the player controls on NEW", async () => {
        const { controls } = setupPlayer();

        await loadVideo("vid1");

        const btn = controls.querySelector("img.bookmark-btn");
        expect(btn).not.toBeNull();
        expect(btn.classList.contains("ytp-button")).toBe(true);
        expect(btn.src).toBe("chrome-extension://test-extension-id/assets/bookmark.png");
        expect(chrome.storage.sync.get).toHaveBeenCalledWith(["vid1"], expect.any(Function));
    });

    it("does not add a second button when one already exists", async () => {
        const { controls } = setupPlayer();

        await loadVideo("vid1");
        await loadVideo("vid1");

        expect(controls.querySelectorAll(".bookmark-btn")).toHaveLength(1);
    });

    it("clicking the button stores a bookmark with a formatted description", async () => {
        const { controls, video } = setupPlayer();
        await loadVideo("vid2");
        video.currentTime = 65;

        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData.vid2)).toEqual([{ time: 65, desc: "Bookmark at 00:01:05" }]);
    });

    it("keeps bookmarks sorted by time", async () => {
        const { controls, video } = setupPlayer();
        await loadVideo("vid3");

        video.currentTime = 120;
        controls.querySelector(".bookmark-btn").click();
        await flushPromises();
        video.currentTime = 30;
        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData.vid3).map((b) => b.time)).toEqual([30, 120]);
    });

    it("PLAY seeks the video to the requested time", async () => {
        const { video } = setupPlayer();
        await loadVideo("vid4");

        const isAsync = onMessage({ source: "yt-watch", type: "PLAY", value: 42 }, {}, () => {});

        expect(isAsync).toBe(false);
        expect(video.currentTime).toBe(42);
    });

    it("navigating to a watch URL via yt-navigate-finish sets up bookmarks without a background message", async () => {
        const { controls, video } = setupPlayer();

        goTo("/watch?v=nav-video");
        await flushPromises();

        expect(chrome.storage.sync.get).toHaveBeenCalledWith(["nav-video"], expect.any(Function));
        const btn = controls.querySelector("img.bookmark-btn");
        expect(btn).not.toBeNull();

        video.currentTime = 7;
        btn.click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData["nav-video"])).toEqual([{ time: 7, desc: "Bookmark at 00:00:07" }]);
    });

    it("navigating home via yt-navigate-finish does not touch bookmark storage", async () => {
        goTo("/");
        await flushPromises();

        expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    });

    it("DELETE removes the bookmark, persists and responds asynchronously", async () => {
        setupPlayer();
        chrome.__storageData.vid5 = JSON.stringify([
            { time: 10, desc: "Bookmark at 00:00:10" },
            { time: 20, desc: "Bookmark at 00:00:20" },
        ]);
        await loadVideo("vid5");
        const response = vi.fn();

        const isAsync = onMessage({ source: "yt-watch", type: "DELETE", value: "10" }, {}, response);

        expect(isAsync).toBe(true);
        expect(response).toHaveBeenCalledWith([{ time: 20, desc: "Bookmark at 00:00:20" }]);
        expect(JSON.parse(chrome.__storageData.vid5)).toEqual([{ time: 20, desc: "Bookmark at 00:00:20" }]);
    });
});
