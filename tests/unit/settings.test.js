import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushPromises } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const body = read("settings.html").match(/<body>([\s\S]*)<\/body>/)[1];

const SITES_KEY = "attention_blocked_sites";
const SETTINGS_KEY = "attention_settings";
const TEMP_UNBLOCKS_KEY = "attention_temp_unblocks";

// Unique ids per test: the page's module-level UI state (open editor) carries
// across tests in this file, and a stale id must never match a fresh site
let siteCounter = 0;
const site = (overrides = {}) => ({
    id: "site-" + ++siteCounter + "-" + (overrides.domain ?? "facebook.com"),
    ruleId: 1,
    domain: "facebook.com",
    enabled: true,
    schedule: null,
    ...overrides,
});

// setPin hashes with WebCrypto, which can resolve on a macrotask: one
// setTimeout round is not always enough for the store write to land
const settle = async () => {
    for (let i = 0; i < 5; i++) await flushPromises();
};

const storeSites = (...sites) => {
    chrome.__syncData[SITES_KEY] = JSON.stringify({ nextRuleId: sites.length + 1, sites });
};

const storedSites = () => JSON.parse(chrome.__syncData[SITES_KEY]).sites;
const storedSettings = () => JSON.parse(chrome.__syncData[SETTINGS_KEY]);

const renderPage = async () => {
    document.body.innerHTML = body;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flushPromises();
};

const rows = () => [...document.querySelectorAll(".site-row")];
const rowFor = (domain) => document.querySelector(`.site-row[data-domain="${domain}"]`);
const summaryOf = (domain) => rowFor(domain).querySelector(".site-summary").textContent;
const text = (selector) => document.querySelector(selector)?.textContent ?? null;

const addSite = async (value) => {
    document.getElementById("add-site-input").value = value;
    document.getElementById("add-site-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flushPromises();
};

let confirmSpy;

beforeAll(async () => {
    // jsdom's own confirm() reports "not implemented" to stderr; tests choose the answer
    confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    await import("../../settings.js");
});

beforeEach(() => {
    confirmSpy.mockClear();
    confirmSpy.mockReturnValue(true);
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("page navigation", () => {
    it("marks the settings tab as current here, and every page links to every page", () => {
        for (const file of ["settings.html", "videos.html", "timestamps.html", "playlist.html"]) {
            const html = read(file);
            for (const target of ["videos.html", "timestamps.html", "settings.html"]) {
                expect(html, `${file} should link to ${target}`).toContain(`href="${target}"`);
            }
        }
        expect(read("settings.html")).toContain('id="tab-settings" class="tab active"');
    });
});

describe("blocked sites list", () => {
    it("shows an empty state when nothing is blocked", async () => {
        await renderPage();
        expect(text(".site-empty")).toBe("No blocked sites. Add one above.");
    });

    it("lists sites with a wording of their schedule", async () => {
        storeSites(
            site(),
            site({ domain: "reddit.com", ruleId: 2, schedule: { start: "13:00", end: "18:00", days: [5, 6] } }),
            site({ domain: "x.com", ruleId: 3, schedule: { start: "22:00", end: "06:00", days: [] } }),
            site({ domain: "news.ycombinator.com", ruleId: 4, enabled: false })
        );
        await renderPage();

        expect(summaryOf("facebook.com")).toBe("Always blocked");
        expect(summaryOf("reddit.com")).toBe("1:00 PM – 6:00 PM on Fri and Sat");
        expect(summaryOf("x.com")).toBe("10:00 PM – 6:00 AM (overnight) every day");
        expect(summaryOf("news.ycombinator.com")).toBe("Disabled");
        expect(rowFor("news.ycombinator.com").classList.contains("disabled")).toBe(true);
    });

    it("adds a site from the form, normalized, and clears the input", async () => {
        await renderPage();
        await addSite("https://www.Reddit.com/r/all");

        expect(storedSites().map((s) => s.domain)).toEqual(["reddit.com"]);
        expect(rowFor("reddit.com")).not.toBeNull();
        expect(document.getElementById("add-site-input").value).toBe("");
    });

    it("shows the store's message for an invalid or duplicate site and keeps what was typed", async () => {
        storeSites(site());
        await renderPage();

        await addSite("not a site");
        expect(text("#add-site-error")).toBe('"not a site" doesn\'t look like a site address');
        expect(document.getElementById("add-site-input").value).toBe("not a site");

        await addSite("facebook.com");
        expect(text("#add-site-error")).toBe("facebook.com is already in the list");
        expect(storedSites()).toHaveLength(1);
    });

    it("the switch disables and re-enables a site", async () => {
        storeSites(site());
        await renderPage();

        const toggle = rowFor("facebook.com").querySelector(".switch input");
        expect(toggle.checked).toBe(true);
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
        await flushPromises();

        expect(storedSites()[0].enabled).toBe(false);
        expect(summaryOf("facebook.com")).toBe("Disabled");
    });

    it("the trash button removes the site", async () => {
        storeSites(site(), site({ domain: "reddit.com", ruleId: 2 }));
        await renderPage();

        rowFor("reddit.com").querySelector(".icon-action.danger").click();
        await flushPromises();

        expect(storedSites().map((s) => s.domain)).toEqual(["facebook.com"]);
        expect(rowFor("reddit.com")).toBeNull();
    });

    it("re-renders when the sites change in another context", async () => {
        storeSites(site());
        await renderPage();
        expect(rows()).toHaveLength(1);

        chrome.storage.sync.set({
            [SITES_KEY]: JSON.stringify({ nextRuleId: 3, sites: [site(), site({ domain: "reddit.com", ruleId: 2 })] }),
        });
        await flushPromises();

        expect(rows()).toHaveLength(2);
    });
});

describe("schedule editor", () => {
    const openEditor = async (domain) => {
        rowFor(domain).querySelector('[aria-label^="Edit schedule"]').click();
        await flushPromises();
        return document.querySelector(".schedule-editor");
    };

    const saveEditor = async () => {
        document.querySelector(".schedule-editor").dispatchEvent(new Event("submit", { cancelable: true }));
        await flushPromises();
    };

    it("opens prefilled for an always-blocked site and saves a custom schedule", async () => {
        storeSites(site());
        await renderPage();

        const editor = await openEditor("facebook.com");
        expect(editor.querySelector('input[value="always"]').checked).toBe(true);

        const custom = editor.querySelector('input[value="custom"]');
        custom.checked = true;
        custom.dispatchEvent(new Event("change"));
        await flushPromises();

        const refreshed = document.querySelector(".schedule-editor");
        const [start, end] = refreshed.querySelectorAll('input[type="time"]');
        expect([start.value, end.value]).toEqual(["13:00", "18:00"]); // suggested default
        start.value = "09:30";
        start.dispatchEvent(new Event("input"));
        end.value = "17:00";
        end.dispatchEvent(new Event("input"));
        for (const day of ["Fri", "Sat"]) {
            const chip = refreshed.querySelector(`.day-chip input[aria-label="${day}"]`);
            chip.checked = true;
            chip.dispatchEvent(new Event("change"));
        }
        await saveEditor();

        expect(storedSites()[0].schedule).toEqual({ start: "09:30", end: "17:00", days: [5, 6] });
        expect(summaryOf("facebook.com")).toBe("9:30 AM – 5:00 PM on Fri and Sat");
        expect(document.querySelector(".schedule-editor")).toBeNull(); // closed after saving
    });

    it("opens prefilled with the current schedule and can clear back to always", async () => {
        storeSites(site({ schedule: { start: "13:00", end: "18:00", days: [5] } }));
        await renderPage();

        const editor = await openEditor("facebook.com");
        expect(editor.querySelector('input[value="custom"]').checked).toBe(true);
        const [start, end] = editor.querySelectorAll('input[type="time"]');
        expect([start.value, end.value]).toEqual(["13:00", "18:00"]);
        expect(editor.querySelector('.day-chip input[aria-label="Fri"]').checked).toBe(true);

        const always = editor.querySelector('input[value="always"]');
        always.checked = true;
        always.dispatchEvent(new Event("change"));
        await saveEditor();

        expect(storedSites()[0].schedule).toBeNull();
        expect(summaryOf("facebook.com")).toBe("Always blocked");
    });

    it("shows the store's validation message and stays open", async () => {
        storeSites(site());
        await renderPage();

        const editor = await openEditor("facebook.com");
        const custom = editor.querySelector('input[value="custom"]');
        custom.checked = true;
        custom.dispatchEvent(new Event("change"));
        await flushPromises();

        const refreshed = document.querySelector(".schedule-editor");
        const [start, end] = refreshed.querySelectorAll('input[type="time"]');
        start.value = "13:00";
        start.dispatchEvent(new Event("input"));
        end.value = "13:00";
        end.dispatchEvent(new Event("input"));
        await saveEditor();

        expect(text(".schedule-editor .form-error")).toBe("Start and end times must be different");
        expect(storedSites()[0].schedule).toBeNull();
    });

    it("cancel closes without saving; the editor also closes if the site is removed elsewhere", async () => {
        storeSites(site());
        await renderPage();

        let editor = await openEditor("facebook.com");
        editor.querySelector("button.btn:not(.btn-primary)").click();
        await flushPromises();
        expect(document.querySelector(".schedule-editor")).toBeNull();
        expect(storedSites()[0].schedule).toBeNull();

        await openEditor("facebook.com");
        chrome.storage.sync.set({ [SITES_KEY]: JSON.stringify({ nextRuleId: 2, sites: [] }) });
        await flushPromises();
        expect(document.querySelector(".schedule-editor")).toBeNull();
    });
});

describe("Shorts & Reels toggles", () => {
    it("reflects the stored settings (hidden by default)", async () => {
        await renderPage();
        expect(document.getElementById("toggle-shorts").checked).toBe(true);
        expect(document.getElementById("toggle-reels").checked).toBe(true);
    });

    it("persists a change per toggle", async () => {
        await renderPage();

        const shorts = document.getElementById("toggle-shorts");
        shorts.checked = false;
        shorts.dispatchEvent(new Event("change"));
        await flushPromises();

        expect(storedSettings().hideShortsReels).toEqual({ youtubeShorts: false, facebookReels: true });
        expect(document.getElementById("toggle-reels").checked).toBe(true);
    });
});

describe("unblock PIN", () => {
    const fillPin = (first, second) => {
        const firstInput = document.getElementById("pin-first");
        const secondInput = document.getElementById("pin-second");
        firstInput.value = first;
        firstInput.dispatchEvent(new Event("input"));
        secondInput.value = second;
        secondInput.dispatchEvent(new Event("input"));
    };

    const submitPin = async () => {
        document.getElementById("pin-form").dispatchEvent(new Event("submit", { cancelable: true }));
        await settle();
    };

    it("without a PIN: explains, offers Set PIN and no Remove button", async () => {
        await renderPage();

        expect(text(".pin-status")).toBe("No PIN set: blocked pages don't offer a temporary unblock.");
        expect(text("#pin-form button[type=submit]")).toBe("Set PIN");
        expect(document.querySelector(".btn-danger")).toBeNull();
    });

    it("sets a PIN when both entries match, stores only the hash and says so", async () => {
        await renderPage();

        fillPin("1234", "1234");
        await submitPin();

        expect(storedSettings().pinHash).toMatch(/^[0-9a-f]{64}$/);
        expect(chrome.__syncData[SETTINGS_KEY]).not.toContain("1234");
        expect(text("#pin-notice")).toBe("PIN set");
        expect(text(".pin-status")).toBe("A PIN is set.");
        expect(text("#pin-form button[type=submit]")).toBe("Change PIN");
        expect(document.getElementById("pin-first").value).toBe("");
    });

    it("rejects mismatched entries without writing", async () => {
        await renderPage();

        fillPin("1234", "5678");
        await submitPin();

        expect(text("#pin-error")).toBe("The PINs don't match");
        expect(chrome.__syncData[SETTINGS_KEY]).toBeUndefined();
        expect(document.getElementById("pin-first").value).toBe("1234"); // kept for correction
    });

    it("surfaces the store's minimum-length message", async () => {
        await renderPage();

        fillPin("12", "12");
        await submitPin();

        expect(text("#pin-error")).toBe("Use at least 4 characters");
    });

    it("changing the PIN replaces the hash and says 'PIN changed'", async () => {
        await renderPage();
        fillPin("1234", "1234");
        await submitPin();
        const firstHash = storedSettings().pinHash;

        fillPin("abcd", "abcd");
        await submitPin();

        expect(storedSettings().pinHash).not.toBe(firstHash);
        expect(text("#pin-notice")).toBe("PIN changed");
    });

    it("removing the PIN asks for confirmation, clears the hash and temporary unblocks", async () => {
        chrome.__storageData[TEMP_UNBLOCKS_KEY] = JSON.stringify({ "facebook.com": Date.now() + 60_000 });
        await renderPage();
        fillPin("1234", "1234");
        await submitPin();

        document.querySelector(".btn-danger").click();
        await settle();

        expect(confirmSpy).toHaveBeenCalledOnce();
        expect(storedSettings().pinHash).toBeNull();
        expect(JSON.parse(chrome.__storageData[TEMP_UNBLOCKS_KEY])).toEqual({});
        expect(text("#pin-notice")).toBe("PIN removed");
        expect(text("#pin-form button[type=submit]")).toBe("Set PIN");
    });

    it("keeps the PIN when the confirmation is declined", async () => {
        await renderPage();
        fillPin("1234", "1234");
        await submitPin();
        confirmSpy.mockReturnValue(false);

        document.querySelector(".btn-danger").click();
        await settle();

        expect(storedSettings().pinHash).toMatch(/^[0-9a-f]{64}$/);
    });
});
