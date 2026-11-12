import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { flushPromises } from "./helpers.js";
import {
    createScreenTimeTracker,
    decideDomain,
    trackedDomainFor,
    SESSION_KEY,
    SCREEN_TIME_ALARM,
    IDLE_DETECTION_SECONDS,
    MAX_CREDIT_MS,
} from "../../screenTime.js";

let SETTINGS, STATS;

beforeAll(async () => {
    await import("../../settingsStore.js");
    await import("../../statsStore.js");
    SETTINGS = globalThis.ATTENTION_SETTINGS;
    STATS = globalThis.ATTENTION_STATS;
});

// Thursday 12 November 2026, 15:00 local time
const START = new Date(2026, 10, 12, 15, 0).getTime();
const TODAY_KEY = "attention_stats_day_2026-11-12";

let clock;
let tracker;

beforeEach(() => {
    clock = START;
    tracker = createScreenTimeTracker({ settings: SETTINGS, stats: STATS, now: () => clock });
});

const showTab = (url, { focused = true, audible = false } = {}) => {
    chrome.__setWindow({ id: 1, focused, tabs: [{ id: 9, url: "https://example.org/", active: false }, { id: 10, url, active: true, audible }] });
};
const later = (ms) => {
    clock += ms;
};
const screenTime = () => JSON.parse(chrome.__storageData[TODAY_KEY] ?? "{}").screenTimeMs ?? {};
const session = () => JSON.parse(chrome.__sessionData[SESSION_KEY] ?? "null");

describe("trackedDomainFor", () => {
    const domains = ["youtube.com", "facebook.com", "music.youtube.com"];

    it.each([
        ["https://www.youtube.com/watch?v=1", "youtube.com"],
        ["https://m.facebook.com/", "facebook.com"],
        ["https://music.youtube.com/playlist", "music.youtube.com"],
        ["http://youtube.com/", "youtube.com"],
    ])("%s -> %s", (url, expected) => {
        expect(trackedDomainFor(url, domains, (d, u) => SETTINGS.domainMatches(d, u))).toBe(expected);
    });

    it.each([
        "https://youtube.com.evil.com/",
        "https://example.com/",
        "chrome-extension://abc/blocked.html?site=youtube.com",
        "chrome://newtab/",
        undefined,
    ])("%s is not tracked", (url) => {
        expect(trackedDomainFor(url, domains, (d, u) => SETTINGS.domainMatches(d, u))).toBeNull();
    });
});

describe("decideDomain", () => {
    const base = {
        trackedDomains: ["youtube.com"],
        domainMatches: (d, u) => SETTINGS.domainMatches(d, u),
    };
    const youtube = (audible) => ({ url: "https://www.youtube.com/watch?v=1", audible });

    it.each([
        ["focused and active", { windowFocused: true, idleState: "active", tab: youtube(false) }, "youtube.com"],
        ["idle but playing sound (watching a video)", { windowFocused: true, idleState: "idle", tab: youtube(true) }, "youtube.com"],
        ["unfocused but playing sound", { windowFocused: false, idleState: "active", tab: youtube(true) }, "youtube.com"],
        ["idle and silent", { windowFocused: true, idleState: "idle", tab: youtube(false) }, null],
        ["unfocused and silent", { windowFocused: false, idleState: "active", tab: youtube(false) }, null],
        ["locked, even with sound", { windowFocused: true, idleState: "locked", tab: youtube(true) }, null],
        ["no active tab", { windowFocused: true, idleState: "active", tab: undefined }, null],
        [
            "on an untracked site",
            { windowFocused: true, idleState: "active", tab: { url: "https://example.com/", audible: true } },
            null,
        ],
    ])("%s -> %s", (_, state, expected) => {
        expect(decideDomain({ ...base, ...state })).toBe(expected);
    });
});

describe("tracker checkpoints", () => {
    it("starts measuring on a tracked site and wakes up every minute while it does", async () => {
        showTab("https://www.youtube.com/");

        await tracker.checkpoint();

        expect(session()).toEqual({ domain: "youtube.com", start: START });
        expect(chrome.alarms.create).toHaveBeenCalledWith(SCREEN_TIME_ALARM, { periodInMinutes: 1 });
        expect(screenTime()).toEqual({});
    });

    it("credits the time so far at each checkpoint and keeps measuring", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(60_000);
        await tracker.checkpoint();
        later(45_000);
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": 105_000 });
        expect(session()).toEqual({ domain: "youtube.com", start: START + 105_000 });
        // The heartbeat is created once, not re-created by every checkpoint
        expect(chrome.alarms.create).toHaveBeenCalledTimes(1);
    });

    it("moves to the new site when the tab changes", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(20_000);
        showTab("https://www.facebook.com/");
        await tracker.checkpoint();
        later(10_000);
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": 20_000, "facebook.com": 10_000 });
    });

    it("stops (and drops the heartbeat) on an untracked site", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(30_000);
        showTab("https://docs.example.com/");
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": 30_000 });
        expect(session()).toBeNull();
        expect(chrome.alarms.clear).toHaveBeenCalledWith(SCREEN_TIME_ALARM);

        later(60_000);
        await tracker.checkpoint();
        expect(screenTime()).toEqual({ "youtube.com": 30_000 });
    });

    it.each([
        ["the browser loses focus", () => showTab("https://www.youtube.com/", { focused: false })],
        ["the user goes idle", () => chrome.__setIdleState("idle")],
        ["the screen locks", () => chrome.__setIdleState("locked")],
        ["no browser window is left", () => chrome.__setWindow(null)],
    ])("stops when %s", async (_, change) => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(40_000);
        change();
        await tracker.checkpoint();
        later(60_000);
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": 40_000 });
        expect(session()).toBeNull();
    });

    it("keeps counting a video playing while the user is idle", async () => {
        showTab("https://www.youtube.com/watch?v=1", { audible: true });
        chrome.__setIdleState("idle");
        await tracker.checkpoint();

        later(60_000);
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": 60_000 });
    });

    it("tracks sites on the block list, enabled or not, by their most specific domain", async () => {
        await SETTINGS.addSite("reddit.com");
        const music = await SETTINGS.addSite("music.youtube.com");
        await SETTINGS.toggleSite(music.id, false);

        showTab("https://old.reddit.com/r/all");
        await tracker.checkpoint();
        later(5_000);
        showTab("https://music.youtube.com/");
        await tracker.checkpoint();
        later(7_000);
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "reddit.com": 5_000, "music.youtube.com": 7_000 });
    });

    it("never credits more than MAX_CREDIT_MS for one interval (sleep, missed events)", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(3 * 60 * 60 * 1000);
        await tracker.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": MAX_CREDIT_MS });
    });

    it("leaves intervals under a second running instead of writing them", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();
        chrome.storage.local.set.mockClear();

        later(400);
        await tracker.checkpoint();
        later(400);
        await tracker.checkpoint();

        expect(chrome.storage.local.set).not.toHaveBeenCalled();
        expect(session().start).toBe(START);

        later(400); // 1.2 s in total
        await tracker.checkpoint();
        expect(screenTime()).toEqual({ "youtube.com": 1_200 });
    });

    it("credits nothing when the clock went backwards, and starts over", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(-60_000);
        showTab("https://www.facebook.com/");
        await tracker.checkpoint();

        expect(screenTime()).toEqual({});
        expect(session()).toEqual({ domain: "facebook.com", start: START - 60_000 });
    });

    it("continues an interval after the worker restarts (a new tracker, same session storage)", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        const restarted = createScreenTimeTracker({ settings: SETTINGS, stats: STATS, now: () => clock });
        later(50_000);
        await restarted.checkpoint();

        expect(screenTime()).toEqual({ "youtube.com": 50_000 });
    });

    it("ignores an unreadable stored interval", async () => {
        chrome.__sessionData[SESSION_KEY] = "not json";
        showTab("https://www.youtube.com/");

        await tracker.checkpoint();

        expect(screenTime()).toEqual({});
        expect(session()).toEqual({ domain: "youtube.com", start: START });
    });

    it("clears a heartbeat left from a previous run when nothing is tracked", async () => {
        await tracker.checkpoint();

        expect(chrome.alarms.clear).toHaveBeenCalledWith(SCREEN_TIME_ALARM);
        expect(chrome.alarms.create).not.toHaveBeenCalled();
    });

    it("keeps measuring when a credit can't be written", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const failingStats = { record: vi.fn(() => Promise.reject(new Error("quota"))) };
        tracker = createScreenTimeTracker({ settings: SETTINGS, stats: failingStats, now: () => clock });
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(30_000);
        await tracker.checkpoint();

        expect(failingStats.record).toHaveBeenCalledWith(
            { event: "screenTime", domain: "youtube.com", ms: 30_000 },
            new Date(START + 30_000)
        );

        expect(errorSpy).toHaveBeenCalledWith("Attention: recording screen time failed", expect.any(Error));
        expect(session()).toEqual({ domain: "youtube.com", start: START + 30_000 });
        errorSpy.mockRestore();
    });

    it("applies a burst of checkpoints in order without crediting twice", async () => {
        showTab("https://www.youtube.com/");
        await tracker.checkpoint();

        later(30_000);
        await Promise.all([tracker.checkpoint(), tracker.checkpoint(), tracker.checkpoint()]);
        await flushPromises();
        await flushPromises();

        expect(screenTime()).toEqual({ "youtube.com": 30_000 });
    });
});

describe("register", () => {
    // A fresh tracker per test registers its own listeners; the newest one is last
    const last = (listeners) => listeners[listeners.length - 1];

    const settle = async () => {
        for (let i = 0; i < 5; i++) await flushPromises();
    };

    beforeEach(() => {
        tracker.register();
        showTab("https://www.youtube.com/");
    });

    it("sets the idle threshold", () => {
        expect(chrome.idle.setDetectionInterval).toHaveBeenCalledWith(IDLE_DETECTION_SECONDS);
    });

    it.each([
        ["a tab is activated", () => last(chrome.__tabActivatedListeners)({ tabId: 10, windowId: 1 })],
        ["a tab is closed", () => last(chrome.__tabRemovedListeners)(10, {})],
        ["the focused window changes", () => last(chrome.__focusChangedListeners)(1)],
        ["the idle state changes", () => last(chrome.__idleStateListeners)("active")],
        ["a tab's URL changes", () => last(chrome.__tabUpdatedListeners)(10, { url: "https://www.youtube.com/" }, {})],
        ["a tab starts or stops playing sound", () => last(chrome.__tabUpdatedListeners)(10, { audible: false }, {})],
    ])("checks where time goes when %s", async (_, fire) => {
        fire();
        await settle();

        expect(session()).toEqual({ domain: "youtube.com", start: START });
    });

    it("ignores other tab updates (title, favicon, loading)", async () => {
        last(chrome.__tabUpdatedListeners)(10, { title: "New title" }, {});
        last(chrome.__tabUpdatedListeners)(10, { status: "loading" }, {});
        await settle();

        expect(session()).toBeNull();
    });
});
