import { describe, it, expect, beforeAll, beforeEach } from "vitest";

let onTabUpdated;

beforeAll(async () => {
    await import("../../background.js");
    onTabUpdated = chrome.__tabUpdatedListeners[0];
});

describe("background.js tab listener", () => {
    beforeEach(() => {
        chrome.tabs.sendMessage.mockImplementation(() => Promise.resolve());
    });

    it("registers exactly one onUpdated listener", () => {
        expect(chrome.__tabUpdatedListeners).toHaveLength(1);
        expect(typeof onTabUpdated).toBe("function");
    });

    it("sends yt-watch NEW with the video id when a watch page finishes loading", () => {
        onTabUpdated(7, { status: "complete" }, { url: "https://www.youtube.com/watch?v=abc123&t=10s" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
            url: "https://www.youtube.com/watch?v=abc123&t=10s",
            source: "yt-watch",
            type: "NEW",
            videoId: "abc123",
        });
    });

    it("sends yt-home for non-watch YouTube pages", () => {
        onTabUpdated(3, { status: "complete" }, { url: "https://www.youtube.com/" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(3, {
            url: "https://www.youtube.com/",
            source: "yt-home",
        });
    });

    it("sends fb for Facebook pages", () => {
        onTabUpdated(5, { status: "complete" }, { url: "https://www.facebook.com/reels" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(5, {
            url: "https://www.facebook.com/reels",
            source: "fb",
        });
    });

    it("sends on in-page (SPA) URL changes even without a complete status", () => {
        onTabUpdated(9, { url: "https://www.youtube.com/watch?v=spa" }, { url: "https://www.youtube.com/watch?v=spa" });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ source: "yt-watch", videoId: "spa" });
    });

    it("ignores intermediate updates (loading, title, favicon)", () => {
        const tab = { url: "https://www.youtube.com/" };
        onTabUpdated(1, { status: "loading" }, tab);
        onTabUpdated(1, { title: "YouTube" }, tab);
        onTabUpdated(1, { favIconUrl: "https://www.youtube.com/favicon.ico" }, tab);

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("ignores tabs on other sites", () => {
        onTabUpdated(2, { status: "complete" }, { url: "https://example.com/watch?v=nope" });
        onTabUpdated(4, { status: "complete" }, { url: undefined });

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("swallows sendMessage rejections (content script not injected yet)", async () => {
        chrome.tabs.sendMessage.mockImplementation(() =>
            Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
        );

        expect(() => onTabUpdated(1, { status: "complete" }, { url: "https://www.youtube.com/" })).not.toThrow();
        // Let the rejected promise settle; an unhandled rejection would fail the test run
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
