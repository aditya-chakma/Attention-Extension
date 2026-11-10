/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.facebook.com/" }
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { flushRemoval } from "./helpers.js";

let onMessage;
let logSpy;
let getURLCallsAtLoad; // snapshot taken right after the script ran, before any per-test mock reset

beforeAll(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../contentScript.js");
    onMessage = chrome.__messageListeners[0];
    getURLCallsAtLoad = chrome.runtime.getURL.mock.calls.map(([path]) => path);
});

afterEach(() => {
    document.body.innerHTML = "";
    logSpy.mockClear();
});

describe("Facebook", () => {
    it("does not redirect from the content script (blocking is done by background.js rules)", () => {
        expect(getURLCallsAtLoad).not.toContain("blocked.html");
    });

    it("removes Reels sections when told the tab is Facebook", () => {
        const reel = document.createElement("div");
        reel.setAttribute("aria-label", "Reels");
        document.body.append(reel);

        const isAsync = onMessage({ source: "fb" }, {}, () => {});

        expect(isAsync).toBe(false);
        expect(document.querySelectorAll('[aria-label="Reels"]')).toHaveLength(0);
        expect(logSpy).toHaveBeenCalledWith("Attention extension has removed 1 reels");
    });

    it("removes Reels sections inserted later", async () => {
        onMessage({ source: "fb" }, {}, () => {});
        const reel = document.createElement("section");
        reel.setAttribute("aria-label", "Reels");
        document.body.append(reel);

        await flushRemoval();

        expect(document.querySelectorAll('[aria-label="Reels"]')).toHaveLength(0);
    });

    it("leaves other labelled sections alone", async () => {
        onMessage({ source: "fb" }, {}, () => {});
        const stories = document.createElement("div");
        stories.setAttribute("aria-label", "Stories");
        document.body.append(stories);

        await flushRemoval();

        expect(document.querySelectorAll('[aria-label="Stories"]')).toHaveLength(1);
    });
});
