import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { flushPromises } from "./helpers.js";

const WATCH_TAB = { id: 11, url: "https://www.youtube.com/watch?v=vid1" };

const renderPopup = async (tab) => {
    document.body.innerHTML = `
        <div class="container">
            <div>
                <div class="title">Your bookmarks for this video</div>
                <div class="bookmarks" id="bookmarks"></div>
            </div>
        </div>
        <button id="open-dashboard" class="icon-btn" aria-label="Open bookmarks dashboard"></button>`;
    chrome.tabs.query.mockResolvedValue(tab ? [tab] : []);
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flushPromises();
};

beforeAll(async () => {
    await import("../../popup.js");
});

describe("popup", () => {
    beforeEach(() => {
        chrome.__storageData.vid1 = JSON.stringify([
            { time: 5, desc: "Bookmark at 00:00:05" },
            { time: 65, desc: "Bookmark at 00:01:05" },
        ]);
    });

    it("lists the bookmarks of the current watch video", async () => {
        await renderPopup(WATCH_TAB);

        const items = document.querySelectorAll("#bookmarks .bookmark");
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe("bookmark-5");
        expect(items[0].getAttribute("timestamp")).toBe("5");
        expect(items[0].querySelector(".bookmark-title").textContent).toBe("Bookmark at 00:00:05");
        expect(items[1].querySelector(".bookmark-title").textContent).toBe("Bookmark at 00:01:05");
        expect([...items[0].querySelectorAll(".bookmark-controls button")].map((b) => b.title)).toEqual(["Play", "Delete"]);
        expect(items[0].querySelectorAll(".bookmark-controls img")).toHaveLength(0);
    });

    it("shows an empty state when the video has no bookmarks", async () => {
        delete chrome.__storageData.vid1;

        await renderPopup(WATCH_TAB);

        expect(document.getElementById("bookmarks").textContent).toBe("No bookmarks to show");
    });

    it("explains when the tab is not a YouTube watch page", async () => {
        await renderPopup({ id: 1, url: "https://www.youtube.com/" });

        expect(document.querySelector(".container").textContent.trim()).toBe("This is not a youtube WATCH video page");
    });

    it("explains when the active tab cannot be read", async () => {
        await renderPopup(undefined);

        expect(document.querySelector(".container").textContent.trim()).toBe("Cannot access current tab information.");
    });

    it("draws the play and delete controls from the central icon registry", async () => {
        await renderPopup(WATCH_TAB);

        const parse = (markup) => new DOMParser().parseFromString(markup, "text/html").body.innerHTML;
        const [play, del] = document.querySelectorAll("#bookmark-5 .bookmark-controls button");
        expect(play.innerHTML).toBe(parse(globalThis.ATTENTION_ICONS.markup.play));
        expect(del.innerHTML).toBe(parse(globalThis.ATTENTION_ICONS.markup.trash));
        expect(play.getAttribute("aria-label")).toBe("Play");
        expect(del.getAttribute("aria-label")).toBe("Delete");
    });

    it("draws the dashboard button icon from the central icon registry", async () => {
        await renderPopup(WATCH_TAB);

        const svg = document.querySelector("#open-dashboard svg");
        expect(svg).not.toBeNull();
        expect(svg.outerHTML).toBe(
            new DOMParser().parseFromString(globalThis.ATTENTION_ICONS.markup.dashboardGrid, "text/html").body.innerHTML
        );
    });

    it("the dashboard icon opens the bookmarked videos page in a new tab", async () => {
        await renderPopup(WATCH_TAB);

        document.getElementById("open-dashboard").click();

        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "chrome-extension://test-extension-id/videos.html",
        });
    });

    it("the dashboard button still works when the tab is not a watch page", async () => {
        await renderPopup({ id: 1, url: "https://www.youtube.com/" });

        document.getElementById("open-dashboard").click();

        expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    });

    it("play sends a PLAY message with the bookmark time to the active tab", async () => {
        await renderPopup(WATCH_TAB);

        // Click the icon itself, as a user would: the row must resolve from the button
        document.querySelector('#bookmark-65 button[title="Play"] svg').dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushPromises();

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(11, { source: "yt-watch", type: "PLAY", value: "65" });
    });

    it("delete removes the row, sends DELETE and re-renders from the response", async () => {
        await renderPopup(WATCH_TAB);
        chrome.tabs.sendMessage.mockImplementation((tabId, msg, callback) => {
            callback([{ time: 65, desc: "Bookmark at 00:01:05" }]);
        });

        document.querySelector('#bookmark-5 button[title="Delete"] svg').dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushPromises();

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            11,
            { source: "yt-watch", type: "DELETE", value: "5" },
            expect.any(Function)
        );
        const items = document.querySelectorAll("#bookmarks .bookmark");
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe("bookmark-65");
    });
});
