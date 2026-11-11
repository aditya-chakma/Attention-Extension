/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.facebook.com/" }
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { flushRemoval, flushPromises } from "./helpers.js";

let onMessage;
let logSpy;
let getURLCallsAtLoad; // snapshot taken right after the script ran, before any per-test mock reset

beforeAll(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../settingsStore.js");
    await import("../../contentScript.js");
    // Removal starts once the toggles have been read from storage
    await flushPromises();
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

describe("Hide Facebook Reels toggle", () => {
    const SETTINGS_KEY = "attention_settings";
    const reel = () => {
        const node = document.createElement("div");
        node.setAttribute("aria-label", "Reels");
        return node;
    };
    const setToggle = async (facebookReels) => {
        chrome.storage.sync.set({ [SETTINGS_KEY]: JSON.stringify({ hideShortsReels: { youtubeShorts: true, facebookReels } }) });
        await flushPromises();
    };

    afterEach(async () => {
        await setToggle(true);
    });

    it("turning the toggle off marks <html> so hide.css shows Reels, and stops removing them", async () => {
        onMessage({ source: "fb" }, {}, () => {});
        await setToggle(false);

        expect(document.documentElement.hasAttribute("data-attention-show-reels")).toBe(true);
        document.body.append(reel());
        await flushRemoval();
        expect(document.querySelectorAll('[aria-label="Reels"]')).toHaveLength(1);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it("turning it back on sweeps the Reels already on the page", async () => {
        onMessage({ source: "fb" }, {}, () => {});
        await setToggle(false);
        document.body.append(reel());
        await flushRemoval();

        await setToggle(true);

        expect(document.documentElement.hasAttribute("data-attention-show-reels")).toBe(false);
        expect(document.querySelectorAll('[aria-label="Reels"]')).toHaveLength(0);
    });
});
