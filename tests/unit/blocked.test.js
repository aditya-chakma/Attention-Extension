import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushPromises } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const body = fs.readFileSync(path.join(root, "blocked.html"), "utf8").match(/<body>([\s\S]*)<\/body>/)[1];

const SITES_KEY = "attention_blocked_sites";
const SETTINGS_KEY = "attention_settings";
const TEMP_UNBLOCKS_KEY = "attention_temp_unblocks";

// Friday 2026-11-13 14:00 local time
const NOW = new Date(2026, 10, 13, 14, 0);

const site = (overrides = {}) => ({
    id: "site-" + (overrides.domain ?? "facebook.com"),
    ruleId: 1,
    domain: "facebook.com",
    enabled: true,
    schedule: null,
    ...overrides,
});

const storeSites = (...sites) => {
    chrome.__syncData[SITES_KEY] = JSON.stringify({ nextRuleId: sites.length + 1, sites });
};

const storePin = () => {
    // SHA-256 of "1234"; what settingsStore.setPin("1234") stores
    chrome.__syncData[SETTINGS_KEY] = JSON.stringify({
        pinHash: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
    });
};

const renderPage = async (query = "?site=facebook.com") => {
    window.history.replaceState({}, "", "/blocked.html" + query);
    document.body.innerHTML = body;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flushPromises();
};

const text = (selector) => document.querySelector(selector)?.textContent ?? null;
const linkHrefs = () => [...document.querySelectorAll(".blocked-links a")].map((a) => a.getAttribute("href"));

beforeAll(async () => {
    await import("../../blocked.js");
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
});

describe("blocked page: what is blocked and why", () => {
    it("names the blocked domain and explains an always-on block", async () => {
        storeSites(site());
        await renderPage();

        expect(text("h1")).toBe("facebook.com is blocked");
        expect(text("h1 .domain")).toBe("facebook.com");
        expect(text(".blocked-reason")).toBe("Blocked all day, every day.");
        expect(document.querySelector(".blocked-until")).toBeNull();
    });

    it("describes a schedule in 12-hour time with its days, and when the block ends", async () => {
        storeSites(site({ schedule: { start: "13:00", end: "18:00", days: [5, 6] } }));
        await renderPage();

        expect(text(".blocked-reason")).toBe("Blocked from 1:00 PM to 6:00 PM on Fridays and Saturdays.");
        expect(text(".blocked-until")).toBe("Blocked until 6:00 PM");
    });

    it.each([
        [[], "every day"],
        [[0, 1, 2, 3, 4, 5, 6], "every day"],
        [[5], "on Fridays"],
        [[1, 3, 5], "on Mondays, Wednesdays and Fridays"],
    ])("describes the days %j as %j", async (days, expected) => {
        storeSites(site({ schedule: { start: "09:00", end: "17:00", days } }));
        await renderPage();

        expect(text(".blocked-reason")).toBe(`Blocked from 9:00 AM to 5:00 PM ${expected}.`);
    });

    it("formats midnight and noon as 12 AM / 12 PM", async () => {
        storeSites(site({ schedule: { start: "22:30", end: "00:15", days: [5] } }));
        vi.setSystemTime(new Date(2026, 10, 13, 23, 0));
        await renderPage();

        expect(text(".blocked-reason")).toBe("Blocked from 10:30 PM to 12:15 AM on Fridays.");
        expect(text(".blocked-until")).toBe("Blocked until 12:15 AM");

        storeSites(site({ schedule: { start: "12:00", end: "13:00", days: [] } }));
        vi.setSystemTime(new Date(2026, 10, 13, 12, 30));
        await renderPage();
        expect(text(".blocked-until")).toBe("Blocked until 1:00 PM");
    });

    it("matches the ?site= parameter after normalizing it", async () => {
        storeSites(site());
        await renderPage("?site=WWW.Facebook.com");

        expect(text("h1")).toBe("facebook.com is blocked");
        expect(text(".blocked-reason")).toBe("Blocked all day, every day.");
    });

    it("falls back to a generic message without a usable ?site= parameter", async () => {
        await renderPage("?site=<script>alert(1)</script>");

        expect(text("h1")).toBe("This site is blocked");
        expect(text(".blocked-reason")).toBe("Access to this site has been restricted.");
        expect(document.querySelector("#unblock-form")).toBeNull();
        expect(document.querySelector(".continue-link")).toBeNull();
        expect(document.querySelector("script")).toBeNull();
    });
});

describe("blocked page: when the block no longer applies", () => {
    it("offers to continue when the site was removed from the list", async () => {
        storeSites();
        await renderPage();

        expect(text(".blocked-reason")).toBe("This site is not blocked right now.");
        const link = document.querySelector("a.continue-link");
        expect(link.textContent).toBe("Continue to facebook.com");
        expect(link.getAttribute("href")).toBe("https://facebook.com/");
        expect(document.querySelector("#unblock-form")).toBeNull();
    });

    it("offers to continue when the site is disabled, outside its schedule or temporarily unblocked", async () => {
        storeSites(site({ enabled: false }));
        await renderPage();
        expect(document.querySelector("a.continue-link")).not.toBeNull();

        storeSites(site({ schedule: { start: "18:00", end: "22:00", days: [] } })); // it is 14:00
        await renderPage();
        expect(document.querySelector("a.continue-link")).not.toBeNull();

        storeSites(site());
        chrome.__storageData[TEMP_UNBLOCKS_KEY] = JSON.stringify({ "facebook.com": NOW.getTime() + 60_000 });
        await renderPage();
        expect(document.querySelector("a.continue-link")).not.toBeNull();
    });

    it("re-renders when the blocked sites or unblocks change elsewhere", async () => {
        storeSites(site());
        await renderPage();
        expect(document.querySelector("a.continue-link")).toBeNull();

        // Removed from the settings page in another tab
        chrome.storage.sync.set({ [SITES_KEY]: JSON.stringify({ nextRuleId: 2, sites: [] }) });
        await flushPromises();
        expect(document.querySelector("a.continue-link")).not.toBeNull();
    });

    it("ignores unrelated storage changes", async () => {
        storeSites(site());
        await renderPage();
        const reads = chrome.storage.sync.get.mock.calls.length;

        chrome.storage.local.set({ vid1: "[]" });
        chrome.storage.sync.set({ other: "x" });
        await flushPromises();

        expect(chrome.storage.sync.get.mock.calls.length).toBe(reads);
    });
});

describe("blocked page: temporary unblock", () => {
    it("without a PIN, points to Settings instead of showing the form", async () => {
        storeSites(site());
        await renderPage();

        expect(document.querySelector("#unblock-form")).toBeNull();
        const note = document.querySelector(".blocked-note");
        expect(note.textContent).toBe("To unblock a site for a while, set a PIN in Settings.");
        expect(note.querySelector("a").getAttribute("href")).toBe("settings.html#pin");
        expect(linkHrefs()).toEqual(["settings.html", "videos.html"]);
    });

    it("with a PIN, shows the form with the duration choices and a reset link", async () => {
        storeSites(site());
        storePin();
        await renderPage();

        const form = document.querySelector("#unblock-form");
        expect(form).not.toBeNull();
        expect(form.querySelector("#pin").type).toBe("password");
        expect([...form.querySelectorAll("#duration option")].map((o) => [o.value, o.textContent])).toEqual([
            ["5", "5 minutes"],
            ["15", "15 minutes"],
            ["30", "30 minutes"],
            ["60", "1 hour"],
        ]);
        expect(linkHrefs()).toEqual(["settings.html#pin", "settings.html", "videos.html"]);
        expect(text(".blocked-links a")).toBe("Forgot your PIN? Reset it in Settings");
    });

    const submitForm = async (pin, minutes) => {
        const form = document.querySelector("#unblock-form");
        form.querySelector("#pin").value = pin;
        form.querySelector("#duration").value = String(minutes);
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        await flushPromises();
        return form;
    };

    it("asks the background worker to unblock and then opens the site", async () => {
        storeSites(site());
        storePin();
        chrome.runtime.sendMessage.mockResolvedValue({ ok: true, expiresAt: NOW.getTime() + 900_000 });
        await renderPage();

        await submitForm("1234", 15);

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "TEMP_UNBLOCK",
            domain: "facebook.com",
            minutes: 15,
            pin: "1234",
        });
        expect(chrome.tabs.update).toHaveBeenCalledWith({ url: "https://facebook.com/" });
    });

    it("shows the worker's refusal, clears the PIN field and lets the user retry", async () => {
        storeSites(site());
        storePin();
        chrome.runtime.sendMessage.mockResolvedValue({ ok: false, error: "Wrong PIN" });
        await renderPage();

        const form = await submitForm("0000", 5);

        expect(text("#unblock-error")).toBe("Wrong PIN");
        expect(form.querySelector("#pin").value).toBe("");
        expect(form.querySelector("button[type=submit]").disabled).toBe(false);
        expect(document.activeElement).toBe(form.querySelector("#pin"));
        expect(chrome.tabs.update).not.toHaveBeenCalled();
    });

    it("explains when the worker cannot be reached", async () => {
        storeSites(site());
        storePin();
        chrome.runtime.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
        await renderPage();

        await submitForm("1234", 5);

        expect(text("#unblock-error")).toBe("Could not reach the extension. Try reloading this page.");
        expect(chrome.tabs.update).not.toHaveBeenCalled();
    });

    it("disables the button while the request is in flight", async () => {
        storeSites(site());
        storePin();
        let resolveReply;
        chrome.runtime.sendMessage.mockReturnValue(new Promise((resolve) => (resolveReply = resolve)));
        await renderPage();

        const form = await submitForm("1234", 5);
        expect(form.querySelector("button[type=submit]").disabled).toBe(true);

        resolveReply({ ok: true });
        await flushPromises();
        expect(chrome.tabs.update).toHaveBeenCalled();
    });
});

describe("blocked page: visit statistic", () => {
    const visitReports = () =>
        chrome.runtime.sendMessage.mock.calls
            .map(([message]) => message)
            .filter((message) => message.type === "STATS_EVENT");

    const navigationType = (type) => {
        vi.spyOn(performance, "getEntriesByType").mockImplementation((entryType) =>
            entryType === "navigation" ? [{ type }] : []
        );
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reports one visit when a blocked site is opened", async () => {
        storeSites(site());
        navigationType("navigate");

        await renderPage();

        expect(visitReports()).toEqual([
            { type: "STATS_EVENT", event: { event: "blockedVisit", domain: "facebook.com" } },
        ]);
    });

    it("reports the normalized domain", async () => {
        storeSites(site());
        await renderPage("?site=WWW.Facebook.com");

        expect(visitReports()[0].event.domain).toBe("facebook.com");
    });

    it.each(["reload", "back_forward"])("doesn't count a %s of the blocked page", async (type) => {
        storeSites(site());
        navigationType(type);

        await renderPage();

        expect(visitReports()).toEqual([]);
    });

    it("doesn't count tabs the background worker moved here itself", async () => {
        storeSites(site());

        await renderPage("?site=facebook.com&reason=auto");

        expect(text("h1")).toBe("facebook.com is blocked");
        expect(visitReports()).toEqual([]);
    });

    it("doesn't count again when the page re-renders after a settings change", async () => {
        storeSites(site());
        await renderPage();

        chrome.storage.sync.set({ [SETTINGS_KEY]: JSON.stringify({ pinHash: "abc" }) });
        await flushPromises();

        expect(document.querySelector("#unblock-form")).not.toBeNull();
        expect(visitReports()).toHaveLength(1);
    });

    it.each([
        ["the site is not blocked right now", () => storeSites(site({ enabled: false }))],
        ["the site is not on the list", () => storeSites()],
    ])("doesn't count when %s", async (_, seed) => {
        seed();

        await renderPage();

        expect(visitReports()).toEqual([]);
    });

    it("doesn't count without a usable ?site= parameter", async () => {
        await renderPage("?site=<script>");

        expect(visitReports()).toEqual([]);
    });

    it("still renders when the worker can't be reached", async () => {
        storeSites(site());
        chrome.runtime.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));

        await renderPage();

        expect(text("h1")).toBe("facebook.com is blocked");
    });
});
