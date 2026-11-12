/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.youtube.com/" }
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { flushRemoval, flushPromises } from "./helpers.js";

const richSection = () => document.createElement("ytd-rich-section-renderer");
const reelShelf = () => document.createElement("ytd-reel-shelf-renderer");

const goTo = (path) => {
    window.history.replaceState({}, "", path);
    document.dispatchEvent(new Event("yt-navigate-finish"));
};

// STATS_EVENT messages the content script sent to the background worker
const statsReports = () =>
    chrome.runtime.sendMessage.mock.calls.map(([message]) => message).filter((m) => m.type === "STATS_EVENT");

// A shelf holding the given Shorts, linked twice each like YouTube's
// thumbnail + title
const shelfWithShorts = (createShelf, ...ids) => {
    const shelf = createShelf();
    for (const id of ids) {
        const item = document.createElement("ytm-shorts-lockup-view-model");
        for (let i = 0; i < 2; i++) {
            const link = document.createElement("a");
            link.href = `/shorts/${id}?feature=shelf`;
            item.append(link);
        }
        shelf.append(item);
    }
    return shelf;
};

let onMessage;
let logSpy;
let atLoad; // snapshot taken right after the script ran, before any per-test mock reset

beforeAll(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Elements present before the script runs must be removed on load
    document.body.append(richSection(), richSection(), reelShelf());

    await import("../../icons.js");
    await import("../../bookmarkStore.js");
    await import("../../settingsStore.js");
    await import("../../contentScript.js");
    // Removal starts once the toggles have been read from storage
    await flushPromises();
    onMessage = chrome.__messageListeners[0];

    atLoad = {
        richSections: document.querySelectorAll("ytd-rich-section-renderer").length,
        reelShelves: document.querySelectorAll("ytd-reel-shelf-renderer").length,
        logs: logSpy.mock.calls.map(([message]) => message),
        getURLCalls: chrome.runtime.getURL.mock.calls.map(([path]) => path),
        statsReports: statsReports(),
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

describe("removal statistics", () => {
    const removal = (count) => ({ type: "STATS_EVENT", event: { event: "removal", kind: "shorts", count } });

    it("reports the shelves removed at load (empty shelves count as one Short each)", () => {
        expect(atLoad.statsReports).toEqual([removal(2)]);
    });

    it("counts the distinct Shorts inside each removed shelf, in one report per sweep", async () => {
        document.body.append(shelfWithShorts(richSection, "a1", "b2", "c3"), shelfWithShorts(richSection, "d4"));

        await flushRemoval();

        expect(statsReports()).toEqual([removal(4)]);
    });

    it("counts Shorts in reel shelves removed on a watch page", () => {
        document.body.append(shelfWithShorts(reelShelf, "x1", "x2"));

        goTo("/watch?v=abc123");

        expect(statsReports()).toEqual([removal(2)]);
    });

    it("ignores links that aren't Shorts", async () => {
        const shelf = shelfWithShorts(richSection, "a1");
        const watchLink = document.createElement("a");
        watchLink.href = "/watch?v=zzz";
        shelf.append(watchLink);
        document.body.append(shelf);

        await flushRemoval();

        expect(statsReports()).toEqual([removal(1)]);
    });

    it("reports nothing when nothing is removed", async () => {
        document.body.append(document.createElement("div"), reelShelf()); // reel shelves stay on the home page

        await flushRemoval();

        expect(statsReports()).toEqual([]);
    });

    it("keeps removing when the extension can't be reached", async () => {
        chrome.runtime.sendMessage.mockImplementation(() => {
            throw new Error("Extension context invalidated.");
        });
        document.body.append(richSection());

        await flushRemoval();

        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(0);
    });
});

describe("Shorts pages (in-app navigation)", () => {
    const redirect = { type: "STATS_EVENT", event: { event: "redirect", kind: "shorts" } };
    const redirectReports = () => statsReports().filter((m) => m.event.event === "redirect");

    // jsdom can't navigate, so location.replace() only logs "Not implemented";
    // the e2e tests check where the tab actually ends up
    let jsdomErrorSpy;
    beforeEach(() => {
        jsdomErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        jsdomErrorSpy.mockRestore();
    });

    it("leaves a Short opened from inside YouTube and counts the redirect", () => {
        goTo("/shorts/abc123");

        expect(redirectReports()).toEqual([redirect]);
    });

    it("counts each Short left only once, however many navigation events fire", async () => {
        goTo("/shorts/abc123");
        document.dispatchEvent(new Event("yt-navigate-finish"));
        window.dispatchEvent(new PopStateEvent("popstate"));
        document.body.append(document.createElement("div")); // DOM observer fallback
        await flushRemoval();

        expect(redirectReports()).toEqual([redirect]);
    });

    it("notices a URL change without a YouTube event (Back/Forward, DOM fallback)", async () => {
        window.history.replaceState({}, "", "/shorts/xyz");
        window.dispatchEvent(new PopStateEvent("popstate"));

        expect(redirectReports()).toEqual([redirect]);
    });

    it.each(["/watch?v=shorts", "/@channel/shorts", "/results?search_query=shorts", "/"])(
        "stays on %s",
        (path) => {
            goTo(path);

            expect(redirectReports()).toEqual([]);
        }
    );
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

        const btn = controls.querySelector("button.bookmark-btn");
        expect(btn).not.toBeNull();
        expect(btn.classList.contains("ytp-button")).toBe(true);
        expect(btn.querySelector("svg path.ytp-svg-fill")).not.toBeNull();
        expect(chrome.storage.local.get).toHaveBeenCalledWith(["vid1"], expect.any(Function));
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

    it("does not save the same timestamp twice (e.g. clicking on a paused video)", async () => {
        const { controls, video } = setupPlayer();
        await loadVideo("vid-dup");
        video.currentTime = 65;

        controls.querySelector(".bookmark-btn").click();
        await flushPromises();
        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData["vid-dup"])).toEqual([{ time: 65, desc: "Bookmark at 00:01:05" }]);
        expect(document.querySelector(".attention-toast").textContent).toBe("Already bookmarked at 00:01:05");
    });

    it("treats times within the same displayed second as the same timestamp", async () => {
        const { controls, video } = setupPlayer();
        await loadVideo("vid-dup-frac");

        video.currentTime = 65.2;
        controls.querySelector(".bookmark-btn").click();
        await flushPromises();
        video.currentTime = 65.8;
        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData["vid-dup-frac"]).map((b) => b.time)).toEqual([65.2]);
    });

    it("rapid clicks before storage responds still save only one bookmark", async () => {
        const { controls, video } = setupPlayer();
        await loadVideo("vid-dup-fast");
        video.currentTime = 30;

        const btn = controls.querySelector(".bookmark-btn");
        btn.click();
        btn.click();
        btn.click();
        await flushPromises();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData["vid-dup-fast"])).toHaveLength(1);
    });

    it("the same time on a different video is not a duplicate", async () => {
        chrome.__storageData["other-vid"] = JSON.stringify([{ time: 65, desc: "Bookmark at 00:01:05" }]);
        const { controls, video } = setupPlayer();
        await loadVideo("vid-dup-other");
        video.currentTime = 65;

        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData["vid-dup-other"])).toHaveLength(1);
        expect(document.querySelector(".attention-toast").textContent).toBe("Bookmarked at 00:01:05");
    });

    it("PLAY seeks the video to the requested time", async () => {
        const { video } = setupPlayer();
        await loadVideo("vid4");

        const isAsync = onMessage({ source: "yt-watch", type: "PLAY", value: 42 }, {}, () => {});

        expect(isAsync).toBe(false);
        expect(video.currentTime).toBe(42);
    });

    it("records the video title alongside the timestamp bookmark", async () => {
        const { controls } = setupPlayer();
        document.title = "Some Tutorial - YouTube";
        await loadVideo("vid-title");

        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData.attention_video_titles)).toEqual({ "vid-title": "Some Tutorial" });
    });

    it("navigating to a watch URL via yt-navigate-finish sets up bookmarks without a background message", async () => {
        const { controls, video } = setupPlayer();

        goTo("/watch?v=nav-video");
        await flushPromises();

        expect(chrome.storage.local.get).toHaveBeenCalledWith(["nav-video"], expect.any(Function));
        const btn = controls.querySelector("button.bookmark-btn");
        expect(btn).not.toBeNull();

        video.currentTime = 7;
        btn.click();
        await flushPromises();

        expect(JSON.parse(chrome.__storageData["nav-video"])).toEqual([{ time: 7, desc: "Bookmark at 00:00:07" }]);
    });

    it("navigating home via yt-navigate-finish does not touch bookmark storage", async () => {
        goTo("/");
        await flushPromises();

        expect(chrome.storage.local.get).not.toHaveBeenCalled();
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

    it("also adds a video bookmark button to the player controls", async () => {
        const { controls } = setupPlayer();

        await loadVideo("vid6");

        const btn = controls.querySelector("button.video-bookmark-btn");
        expect(btn).not.toBeNull();
        expect(btn.classList.contains("ytp-button")).toBe(true);
        expect(btn.title).toBe("Save this video to a playlist");
        expect(btn.querySelector("svg path.ytp-svg-fill")).not.toBeNull();
        expect(controls.querySelectorAll("button.ytp-button")).toHaveLength(2);
    });

    // ---- Save to playlist panel

    const panel = () => document.querySelector(".attention-save-dialog");
    const checkbox = (playlistId) => panel().querySelector(`input[data-playlist-id="${playlistId}"]`);
    const storedVideos = () => JSON.parse(chrome.__storageData.attention_bookmarked_videos || "[]");
    const storedPlaylists = () => JSON.parse(chrome.__storageData.attention_playlists);
    const playlistById = (id) => storedPlaylists().find((p) => p.id === id);
    const toastText = () => document.querySelector(".attention-toast")?.textContent;

    const openPanel = async (controls) => {
        controls.querySelector(".video-bookmark-btn").click();
        await flushPromises();
        return panel();
    };
    const toggle = async (playlistId) => {
        checkbox(playlistId).click();
        await flushPromises();
    };
    const typeNewPlaylist = async (name) => {
        panel().querySelector(".attention-new-playlist-btn").click();
        await flushPromises();
        const input = panel().querySelector(".attention-new-playlist-form input");
        input.value = name;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input;
    };
    const submitNewPlaylist = async () => {
        panel().querySelector(".attention-new-playlist-form").requestSubmit();
        await flushPromises();
        await flushPromises();
    };

    it("clicking the video bookmark button opens a Save to panel listing the default playlists", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-panel");

        const dialog = await openPanel(controls);

        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute("role")).toBe("dialog");
        expect(dialog.querySelector(".attention-save-title").textContent).toBe("Save to…");
        expect([...dialog.querySelectorAll(".attention-playlist-name")].map((n) => n.textContent)).toEqual([
            "Favorites",
            "Watch Later",
        ]);
        expect(checkbox("favorites").checked).toBe(false);
        expect(checkbox("watch-later").checked).toBe(false);
        expect(controls.querySelector(".video-bookmark-btn").getAttribute("aria-expanded")).toBe("true");
        // Opening alone saves nothing
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
        // Nothing to remove yet
        expect(dialog.querySelector(".attention-remove-bookmark")).toBeNull();
    });

    it("checking a playlist bookmarks the video with its title and current time", async () => {
        const { controls, video } = setupPlayer();
        document.title = "My Video - YouTube";
        vi.spyOn(Date, "now").mockReturnValue(1234567890);
        await loadVideo("vid7");
        video.currentTime = 90;
        await openPanel(controls);

        await toggle("favorites");

        expect(storedVideos()).toEqual([{ id: "vid7", title: "My Video", channel: "", time: 90, savedAt: 1234567890 }]);
        expect(playlistById("favorites").videoIds).toEqual(["vid7"]);
        expect(playlistById("watch-later").videoIds).toEqual([]);
        expect(checkbox("favorites").checked).toBe(true);
        expect(toastText()).toBe("Saved to Favorites");
        expect(videoButtonIcon(controls)).toBe("videoBookmarked");
        vi.restoreAllMocks();
    });

    it("stores the channel name from the video owner block", async () => {
        const { controls } = setupPlayer();
        document.body.insertAdjacentHTML(
            "beforeend",
            '<div id="owner"><div id="channel-name"><a href="/@bunny">  Blender Foundation </a></div></div>'
        );
        await loadVideo("vid-channel");
        await openPanel(controls);

        await toggle("favorites");

        expect(storedVideos()[0].channel).toBe("Blender Foundation");
    });

    it("falls back to the author metadata when the owner block is missing", async () => {
        const { controls } = setupPlayer();
        document.body.insertAdjacentHTML(
            "beforeend",
            '<span itemprop="author"><link itemprop="name" content="Meta Channel"></span>'
        );
        await loadVideo("vid-meta");
        await openPanel(controls);

        await toggle("favorites");

        expect(storedVideos()[0].channel).toBe("Meta Channel");
    });

    it("a video can be saved to several playlists and is stored once", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-multi");
        await openPanel(controls);

        await toggle("favorites");
        await toggle("watch-later");

        expect(storedVideos().map((v) => v.id)).toEqual(["vid-multi"]);
        expect(playlistById("favorites").videoIds).toEqual(["vid-multi"]);
        expect(playlistById("watch-later").videoIds).toEqual(["vid-multi"]);
        expect(checkbox("favorites").checked).toBe(true);
        expect(checkbox("watch-later").checked).toBe(true);
    });

    it("unchecking keeps the bookmark while the video is in another playlist, and removes it with the last one", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-uncheck");
        await openPanel(controls);
        await toggle("favorites");
        await toggle("watch-later");

        await toggle("favorites");
        expect(storedVideos().map((v) => v.id)).toEqual(["vid-uncheck"]);
        expect(toastText()).toBe("Removed from Favorites");
        expect(videoButtonIcon(controls)).toBe("videoBookmarked");

        await toggle("watch-later");
        expect(storedVideos()).toEqual([]);
        expect(toastText()).toBe("Removed from Watch Later. Bookmark removed");
        expect(videoButtonIcon(controls)).toBe("videoBookmark");
    });

    it("keeps bookmarks of other videos when bookmarking a new one", async () => {
        chrome.__storageData.attention_bookmarked_videos = JSON.stringify([
            { id: "older", title: "Older", time: 1, savedAt: 1 },
        ]);
        const { controls } = setupPlayer();
        await loadVideo("vid9");
        await openPanel(controls);

        await toggle("watch-later");

        expect(storedVideos().map((v) => v.id)).toEqual(["older", "vid9"]);
    });

    it("creating a new playlist saves the video to it, closes the panel and confirms", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-new-pl");
        await openPanel(controls);

        const input = await typeNewPlaylist("  Study   notes ");
        expect(document.activeElement).toBe(input);
        await submitNewPlaylist();

        const created = storedPlaylists().find((p) => p.name === "Study notes");
        expect(created).toBeDefined();
        expect(created.videoIds).toEqual(["vid-new-pl"]);
        expect(storedVideos().map((v) => v.id)).toEqual(["vid-new-pl"]);
        expect(toastText()).toBe('Bookmarked and playlist "Study notes" created');
        expect(panel()).toBeNull();
        expect(controls.querySelector(".video-bookmark-btn").getAttribute("aria-expanded")).toBe("false");
        expect(videoButtonIcon(controls)).toBe("videoBookmarked");

        // Reopening shows the new playlist checked
        await openPanel(controls);
        expect(checkbox(created.id).checked).toBe(true);
    });

    it("Create is disabled until a name is typed", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-empty-name");
        await openPanel(controls);

        await typeNewPlaylist("   ");

        expect(panel().querySelector(".attention-new-playlist-form button[type=submit]").disabled).toBe(true);
    });

    it("rejects a duplicate playlist name with an inline error and creates nothing", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-dup-name");
        await openPanel(controls);

        await typeNewPlaylist("favorites");
        await submitNewPlaylist();

        expect(panel().querySelector(".attention-form-error").textContent).toBe('A playlist named "favorites" already exists');
        // The form stays open with what was typed
        expect(panel().querySelector(".attention-new-playlist-form input").value).toBe("favorites");
        // A rejected name writes nothing at all
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("Cancel closes the new playlist form without saving", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-cancel");
        await openPanel(controls);
        await typeNewPlaylist("Later");

        panel().querySelector(".attention-new-playlist-form button[type=button]").click();
        await flushPromises();

        expect(panel().querySelector(".attention-new-playlist-form")).toBeNull();
        expect(chrome.__storageData.attention_playlists).toBeUndefined();
    });

    it("Remove from all takes the video out of every playlist and closes the panel", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-remove-all");
        await openPanel(controls);
        await toggle("favorites");
        await toggle("watch-later");

        const removeAll = panel().querySelector(".attention-remove-bookmark");
        expect(removeAll.textContent).toBe("Remove from all");
        removeAll.click();
        await flushPromises();

        expect(storedVideos()).toEqual([]);
        expect(storedPlaylists().every((p) => p.videoIds.length === 0)).toBe(true);
        expect(panel()).toBeNull();
        expect(toastText()).toBe("Removed from all playlists");
        expect(videoButtonIcon(controls)).toBe("videoBookmark");
    });

    it("clicking the bookmark button again closes the panel", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-close-btn");
        await openPanel(controls);

        controls.querySelector(".video-bookmark-btn").click();
        await flushPromises();

        expect(panel()).toBeNull();
        expect(controls.querySelector(".video-bookmark-btn").getAttribute("aria-expanded")).toBe("false");
    });

    it("the close button, Escape and clicking outside all close the panel", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-close");

        await openPanel(controls);
        panel().querySelector(".attention-dialog-close").click();
        expect(panel()).toBeNull();

        await openPanel(controls);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(panel()).toBeNull();

        await openPanel(controls);
        panel().dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(panel()).not.toBeNull(); // clicks inside keep it open
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(panel()).toBeNull();
    });

    it("Escape in the new playlist form only closes the form", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-esc-form");
        await openPanel(controls);
        const input = await typeNewPlaylist("Draft");

        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await flushPromises();

        expect(panel()).not.toBeNull();
        expect(panel().querySelector(".attention-new-playlist-form")).toBeNull();
    });

    it("keys and clicks inside the panel do not reach YouTube's player handlers", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-isolate");
        await openPanel(controls);
        const pageKeydown = vi.fn();
        const pageClick = vi.fn();
        document.addEventListener("keydown", pageKeydown);
        document.addEventListener("click", pageClick);

        const input = await typeNewPlaylist("k");
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
        panel().querySelector(".attention-save-title").click();

        expect(pageKeydown).not.toHaveBeenCalled();
        expect(pageClick).not.toHaveBeenCalled();
        document.removeEventListener("keydown", pageKeydown);
        document.removeEventListener("click", pageClick);
    });

    it("an open panel updates when playlists change elsewhere (e.g. created on the dashboard)", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-live");
        await openPanel(controls);

        await ATTENTION_STORE.createPlaylist("Queue");
        await flushPromises();

        expect([...panel().querySelectorAll(".attention-playlist-name")].map((n) => n.textContent)).toEqual([
            "Favorites",
            "Watch Later",
            "Queue",
        ]);
    });

    it("saves the title without YouTube's notification count", async () => {
        const { controls } = setupPlayer();
        document.title = "(4) Counted Video - YouTube";
        await loadVideo("vid-count");
        await openPanel(controls);

        await toggle("favorites");

        expect(storedVideos()[0].title).toBe("Counted Video");
    });

    it("prefers the title shown on the watch page", async () => {
        const { controls } = setupPlayer();
        document.title = "(4) Tab title - YouTube";
        document.body.insertAdjacentHTML(
            "beforeend",
            "<ytd-watch-metadata><h1><yt-formatted-string> Page heading </yt-formatted-string></h1></ytd-watch-metadata>"
        );
        await loadVideo("vid-heading");
        await openPanel(controls);

        await toggle("favorites");

        expect(storedVideos()[0].title).toBe("Page heading");
    });

    it("marks the player while the panel is open so the toast moves out from behind it", async () => {
        const { controls } = setupPlayer();
        const player = document.createElement("div");
        player.className = "html5-video-player";
        player.append(controls, document.querySelector("video.video-stream"));
        document.body.appendChild(player);
        await loadVideo("vid-toast-pos");

        await openPanel(controls);
        expect(panel().parentElement).toBe(player);
        expect(player.classList.contains("attention-panel-open")).toBe(true);

        panel().querySelector(".attention-dialog-close").click();
        expect(player.classList.contains("attention-panel-open")).toBe(false);
    });

    it("navigating to another video closes the panel", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-nav-1");
        await openPanel(controls);

        goTo("/watch?v=vid-nav-2");
        await flushPromises();

        expect(panel()).toBeNull();
    });

    const videoButtonIcon = (controls) => controls.querySelector(".video-bookmark-btn svg").dataset.icon;

    it("groups both buttons in one container and draws their icons from icons.js", async () => {
        const { controls } = setupPlayer();

        await loadVideo("vid-group");

        const container = controls.querySelector(".attention-player-controls");
        expect(container).not.toBeNull();
        expect([...container.children].map((b) => b.className)).toEqual([
            "ytp-button attention-player-btn bookmark-btn",
            "ytp-button attention-player-btn video-bookmark-btn",
        ]);
        const timestampPath = container.querySelector(".bookmark-btn svg path");
        expect(timestampPath.getAttribute("d")).toBe(ATTENTION_ICONS.paths.timestampBookmark);
        expect(container.querySelector(".bookmark-btn svg").getAttribute("viewBox")).toBe("-6 -6 36 36");
    });

    it("shows an outlined bookmark for a video that is not bookmarked", async () => {
        const { controls } = setupPlayer();

        await loadVideo("vid-unsaved");

        const btn = controls.querySelector(".video-bookmark-btn");
        expect(videoButtonIcon(controls)).toBe("videoBookmark");
        expect(btn.querySelector("path").getAttribute("d")).toBe(ATTENTION_ICONS.paths.videoBookmark);
        expect(btn.dataset.saved).toBe("false");
    });

    it("shows a solid bookmark when loading a video that is already bookmarked", async () => {
        chrome.__storageData.attention_bookmarked_videos = JSON.stringify([{ id: "vid-saved", title: "Saved" }]);
        const { controls } = setupPlayer();

        await loadVideo("vid-saved");

        const btn = controls.querySelector(".video-bookmark-btn");
        expect(videoButtonIcon(controls)).toBe("videoBookmarked");
        expect(btn.querySelector("path").getAttribute("d")).toBe(ATTENTION_ICONS.paths.videoBookmarked);
        expect(btn.dataset.saved).toBe("true");
        expect(btn.title).toBe("Saved. Click to change playlists");
        expect(btn.getAttribute("aria-label")).toBe(btn.title);
    });

    it("goes back to outlined when the video is removed elsewhere (e.g. the dashboard)", async () => {
        chrome.__storageData.attention_bookmarked_videos = JSON.stringify([{ id: "vid-removed" }]);
        const { controls } = setupPlayer();
        await loadVideo("vid-removed");
        expect(videoButtonIcon(controls)).toBe("videoBookmarked");

        chrome.storage.local.set({ attention_bookmarked_videos: JSON.stringify([]) });

        expect(videoButtonIcon(controls)).toBe("videoBookmark");
        expect(controls.querySelector(".video-bookmark-btn").title).toBe("Save this video to a playlist");
    });

    it("re-syncs the icon when navigating to another video, reusing the same buttons", async () => {
        chrome.__storageData.attention_bookmarked_videos = JSON.stringify([{ id: "vid-a" }]);
        const { controls } = setupPlayer();

        await loadVideo("vid-a");
        expect(videoButtonIcon(controls)).toBe("videoBookmarked");

        await loadVideo("vid-b");
        expect(videoButtonIcon(controls)).toBe("videoBookmark");
        expect(controls.querySelectorAll(".attention-player-controls")).toHaveLength(1);
    });

    it("shows a toast confirming the saved timestamp", async () => {
        const { controls, video } = setupPlayer();
        await loadVideo("vid-toast-ts");
        video.currentTime = 65;

        controls.querySelector(".bookmark-btn").click();
        await flushPromises();

        const toast = document.querySelector(".attention-toast");
        expect(toast).not.toBeNull();
        expect(toast.classList.contains("attention-toast-visible")).toBe(true);
        expect(toast.textContent).toBe("Bookmarked at 00:01:05");
        expect(toast.getAttribute("role")).toBe("status");
    });

    it("reuses one toast element instead of stacking them", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-toast-vid");
        await openPanel(controls);

        await toggle("favorites");
        await toggle("favorites");

        const toasts = document.querySelectorAll(".attention-toast");
        expect(toasts).toHaveLength(1);
        expect(toasts[0].textContent).toBe("Removed from Favorites. Bookmark removed");
    });

    it("hides the toast again after a couple of seconds", async () => {
        const { controls } = setupPlayer();
        await loadVideo("vid-toast-hide");

        await openPanel(controls);

        vi.useFakeTimers();
        try {
            checkbox("favorites").click();
            await vi.runAllTimersAsync();

            const toast = document.querySelector(".attention-toast");
            expect(toast.textContent).toBe("Saved to Favorites");
            expect(toast.classList.contains("attention-toast-visible")).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("ignores storage changes to other keys", async () => {
        chrome.__storageData.attention_bookmarked_videos = JSON.stringify([{ id: "vid-other" }]);
        const { controls } = setupPlayer();
        await loadVideo("vid-other");

        chrome.storage.local.set({ "vid-other": JSON.stringify([]) });

        expect(videoButtonIcon(controls)).toBe("videoBookmarked");
    });
});

describe("Hide YouTube Shorts toggle", () => {
    const SETTINGS_KEY = "attention_settings";
    const setToggle = async (youtubeShorts) => {
        chrome.storage.sync.set({ [SETTINGS_KEY]: JSON.stringify({ hideShortsReels: { youtubeShorts, facebookReels: true } }) });
        await flushPromises();
    };

    afterEach(async () => {
        await setToggle(true);
    });

    it("hides by default: no 'show' attribute on <html>", () => {
        expect(document.documentElement.hasAttribute("data-attention-show-shorts")).toBe(false);
    });

    it("turning the toggle off marks <html> so hide.css shows Shorts, and stops removing them", async () => {
        await setToggle(false);
        chrome.runtime.sendMessage.mockClear();

        expect(document.documentElement.hasAttribute("data-attention-show-shorts")).toBe(true);
        expect(document.documentElement.hasAttribute("data-attention-show-reels")).toBe(false);

        document.body.append(richSection());
        await flushRemoval();
        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(1);
        // Shown Shorts aren't blocked ones
        expect(statsReports()).toEqual([]);
    });

    it("turning it back on removes the attribute and sweeps what is already on the page", async () => {
        await setToggle(false);
        document.body.append(richSection());
        await flushRemoval();
        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(1);

        await setToggle(true);

        expect(document.documentElement.hasAttribute("data-attention-show-shorts")).toBe(false);
        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(0);
    });

    it("with the toggle off, Shorts pages stay; switching it on leaves the open one", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // jsdom: no navigation
        const redirects = () => statsReports().filter((m) => m.event.event === "redirect");
        await setToggle(false);

        goTo("/shorts/abc123");
        expect(redirects()).toEqual([]);

        await setToggle(true);
        expect(redirects()).toEqual([{ type: "STATS_EVENT", event: { event: "redirect", kind: "shorts" } }]);
        errorSpy.mockRestore();
    });

    it("ignores the Facebook toggle on YouTube", async () => {
        chrome.storage.sync.set({ [SETTINGS_KEY]: JSON.stringify({ hideShortsReels: { youtubeShorts: true, facebookReels: false } }) });
        await flushPromises();

        document.body.append(richSection());
        await flushRemoval();
        expect(document.querySelectorAll("ytd-rich-section-renderer")).toHaveLength(0);
        expect(document.documentElement.hasAttribute("data-attention-show-reels")).toBe(true);
    });
});
