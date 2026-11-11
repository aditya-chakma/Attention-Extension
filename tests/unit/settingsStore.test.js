import { describe, it, expect, beforeAll } from "vitest";

let SETTINGS;

beforeAll(async () => {
    await import("../../settingsStore.js");
    SETTINGS = globalThis.ATTENTION_SETTINGS;
});

const SITES_KEY = "attention_blocked_sites";
const SETTINGS_KEY = "attention_settings";
const TEMP_UNBLOCKS_KEY = "attention_temp_unblocks";

const storedSites = () => JSON.parse(chrome.__syncData[SITES_KEY]).sites;
const storedSettings = () => JSON.parse(chrome.__syncData[SETTINGS_KEY]);
const storedUnblocks = () => JSON.parse(chrome.__storageData[TEMP_UNBLOCKS_KEY]);

// In November 2026: the 13th is a Friday, the 14th a Saturday, the 15th a Sunday
const friday = (hours, minutes = 0) => new Date(2026, 10, 13, hours, minutes);
const saturday = (hours, minutes = 0) => new Date(2026, 10, 14, hours, minutes);
const sunday = (hours, minutes = 0) => new Date(2026, 10, 15, hours, minutes);

describe("normalizeDomain", () => {
    it.each([
        ["facebook.com", "facebook.com"],
        ["  Reddit.com  ", "reddit.com"],
        ["https://www.Facebook.com/feed?x=1#top", "facebook.com"],
        ["http://m.youtube.com/shorts", "m.youtube.com"],
        ["www.example.co.uk", "example.co.uk"],
        ["example.com:8080/path", "example.com"],
        ["user:pass@example.com", "example.com"],
        ["news.ycombinator.com.", "news.ycombinator.com"],
    ])("turns %j into %j", (input, expected) => {
        expect(SETTINGS.normalizeDomain(input)).toBe(expected);
    });

    it.each(["", "   ", "facebook", "https://", "foo..bar.com", "-bad-.com", "has space.com", "example.123"])(
        "rejects %j",
        (input) => {
            expect(() => SETTINGS.normalizeDomain(input)).toThrow();
        }
    );

    it("names the typed value in the error message", () => {
        expect(() => SETTINGS.normalizeDomain(" facebook ")).toThrow('"facebook" doesn\'t look like a site address');
    });
});

describe("domainMatches", () => {
    it.each([
        ["facebook.com", "https://facebook.com/feed", true],
        ["facebook.com", "https://m.facebook.com/reels", true],
        ["facebook.com", "https://www.facebook.com/", true],
        ["facebook.com", "https://notfacebook.com/", false],
        ["facebook.com", "https://facebook.com.evil.com/", false],
        ["facebook.com", "https://youtube.com/", false],
        ["facebook.com", "chrome-extension://abc/blocked.html?site=facebook.com", false],
        ["facebook.com", "not a url", false],
    ])("%s vs %s -> %s", (domain, url, expected) => {
        expect(SETTINGS.domainMatches(domain, url)).toBe(expected);
    });
});

describe("validateSchedule", () => {
    it("passes null through (always blocked)", () => {
        expect(SETTINGS.validateSchedule(null)).toBeNull();
        expect(SETTINGS.validateSchedule(undefined)).toBeNull();
    });

    it("normalizes times to two digits and sorts/dedupes days", () => {
        expect(SETTINGS.validateSchedule({ start: "9:00", end: "17:30", days: [6, 5, 5] })).toEqual({
            start: "09:00",
            end: "17:30",
            days: [5, 6],
        });
    });

    it("treats missing days as every day", () => {
        expect(SETTINGS.validateSchedule({ start: "13:00", end: "18:00" })).toEqual({
            start: "13:00",
            end: "18:00",
            days: [],
        });
    });

    it.each([
        [{ start: "25:00", end: "18:00", days: [] }, "Times must look like 13:00"],
        [{ start: "13:60", end: "18:00", days: [] }, "Times must look like 13:00"],
        [{ start: 13, end: "18:00", days: [] }, "Times must look like 13:00"],
        [{ start: "13:00", end: "13:00", days: [] }, "Start and end times must be different"],
        [{ start: "13:00", end: "18:00", days: [7] }, "Days must be between 0 (Sunday) and 6 (Saturday)"],
        [{ start: "13:00", end: "18:00", days: [1.5] }, "Days must be between 0 (Sunday) and 6 (Saturday)"],
        [{ start: "13:00", end: "18:00", days: "fri" }, "Days must be a list"],
    ])("rejects %j", (schedule, message) => {
        expect(() => SETTINGS.validateSchedule(schedule)).toThrow(message);
    });
});

describe("isScheduleActive", () => {
    it("no schedule means always blocked", () => {
        expect(SETTINGS.isScheduleActive(null, friday(3))).toBe(true);
    });

    const afternoon = { start: "13:00", end: "18:00", days: [] };

    it("a daytime range blocks from start (inclusive) to end (exclusive)", () => {
        expect(SETTINGS.isScheduleActive(afternoon, friday(12, 59))).toBe(false);
        expect(SETTINGS.isScheduleActive(afternoon, friday(13, 0))).toBe(true);
        expect(SETTINGS.isScheduleActive(afternoon, friday(17, 59))).toBe(true);
        expect(SETTINGS.isScheduleActive(afternoon, friday(18, 0))).toBe(false);
    });

    it("only blocks on the listed days", () => {
        const weekend = { start: "13:00", end: "18:00", days: [5, 6] };
        expect(SETTINGS.isScheduleActive(weekend, friday(14))).toBe(true);
        expect(SETTINGS.isScheduleActive(weekend, saturday(14))).toBe(true);
        expect(SETTINGS.isScheduleActive(weekend, sunday(14))).toBe(false);
    });

    it("an overnight range runs into the morning of the next day", () => {
        const night = { start: "22:00", end: "06:00", days: [5] }; // Friday nights
        expect(SETTINGS.isScheduleActive(night, friday(21, 59))).toBe(false);
        expect(SETTINGS.isScheduleActive(night, friday(23, 0))).toBe(true);
        expect(SETTINGS.isScheduleActive(night, saturday(5, 59))).toBe(true); // Friday night spills into Saturday
        expect(SETTINGS.isScheduleActive(night, saturday(6, 0))).toBe(false);
        expect(SETTINGS.isScheduleActive(night, saturday(23, 0))).toBe(false); // Saturday is not a listed day
        expect(SETTINGS.isScheduleActive(night, sunday(5, 0))).toBe(false); // and so spills nothing into Sunday
    });

    it("an overnight range on every day is continuous through the night", () => {
        const night = { start: "22:00", end: "06:00", days: [] };
        expect(SETTINGS.isScheduleActive(night, friday(2))).toBe(true);
        expect(SETTINGS.isScheduleActive(night, friday(12))).toBe(false);
        expect(SETTINGS.isScheduleActive(night, friday(23))).toBe(true);
    });
});

describe("isSiteBlocked / activeSites", () => {
    const site = (overrides = {}) => ({
        id: "site-x",
        ruleId: 1,
        domain: "facebook.com",
        enabled: true,
        schedule: null,
        ...overrides,
    });

    it("blocks an enabled site with no schedule", () => {
        expect(SETTINGS.isSiteBlocked(site(), {}, friday(12))).toBe(true);
    });

    it("never blocks a disabled site", () => {
        expect(SETTINGS.isSiteBlocked(site({ enabled: false }), {}, friday(12))).toBe(false);
    });

    it("a temporary unblock lifts the block until it expires", () => {
        const now = friday(12);
        const unblocks = { "facebook.com": now.getTime() + 60_000 };
        expect(SETTINGS.isSiteBlocked(site(), unblocks, now)).toBe(false);
        expect(SETTINGS.isSiteBlocked(site(), { "facebook.com": now.getTime() }, now)).toBe(true); // expired
        expect(SETTINGS.isSiteBlocked(site({ domain: "reddit.com" }), unblocks, now)).toBe(true); // other domain
    });

    it("activeSites keeps only the sites blocked right now", () => {
        const sites = [
            site(),
            site({ id: "s2", domain: "reddit.com", enabled: false }),
            site({ id: "s3", domain: "youtube.com", schedule: { start: "13:00", end: "18:00", days: [] } }),
        ];
        expect(SETTINGS.activeSites(sites, {}, friday(12)).map((s) => s.domain)).toEqual(["facebook.com"]);
        expect(SETTINGS.activeSites(sites, {}, friday(14)).map((s) => s.domain)).toEqual(["facebook.com", "youtube.com"]);
    });
});

describe("buildRules", () => {
    it("builds a main-frame redirect rule per site, anchored to the domain", () => {
        const rules = SETTINGS.buildRules([
            { id: "s1", ruleId: 4, domain: "facebook.com", enabled: true, schedule: null },
        ]);
        expect(rules).toEqual([
            {
                id: 4,
                priority: 1,
                action: {
                    type: "redirect",
                    redirect: { extensionPath: "/blocked.html?site=facebook.com" },
                },
                condition: { urlFilter: "||facebook.com^", resourceTypes: ["main_frame"] },
            },
        ]);
    });
});

describe("nextTransition", () => {
    const always = { id: "s1", ruleId: 1, domain: "facebook.com", enabled: true, schedule: null };

    it("is null when nothing will change on its own", () => {
        expect(SETTINGS.nextTransition([always], {}, friday(12))).toBeNull();
        expect(SETTINGS.nextTransition([{ ...always, enabled: false }], {}, friday(12))).toBeNull();
        expect(SETTINGS.nextTransition([], {}, friday(12))).toBeNull();
    });

    it("returns a pending temporary unblock expiry", () => {
        const now = friday(12);
        const expiry = now.getTime() + 5 * 60_000;
        expect(SETTINGS.nextTransition([always], { "facebook.com": expiry }, now)).toBe(expiry);
    });

    it("ignores unblock expiries of disabled or unknown sites", () => {
        const now = friday(12);
        expect(SETTINGS.nextTransition([{ ...always, enabled: false }], { "facebook.com": now.getTime() + 1000 }, now)).toBeNull();
        expect(SETTINGS.nextTransition([always], { "reddit.com": now.getTime() + 1000 }, now)).toBeNull();
    });

    it("returns the upcoming start of a scheduled block", () => {
        const site = { ...always, schedule: { start: "13:00", end: "18:00", days: [5] } };
        expect(SETTINGS.nextTransition([site], {}, friday(12))).toBe(friday(13).getTime());
    });

    it("returns the end of the running block when inside the window", () => {
        const site = { ...always, schedule: { start: "13:00", end: "18:00", days: [5] } };
        expect(SETTINGS.nextTransition([site], {}, friday(14))).toBe(friday(18).getTime());
    });

    it("jumps to next week when this week's window is over", () => {
        const site = { ...always, schedule: { start: "13:00", end: "18:00", days: [5] } };
        const nextFriday = new Date(2026, 10, 20, 13, 0);
        expect(SETTINGS.nextTransition([site], {}, friday(19))).toBe(nextFriday.getTime());
    });

    it("an overnight window ends on the morning after its listed day", () => {
        const site = { ...always, schedule: { start: "22:00", end: "06:00", days: [5] } };
        expect(SETTINGS.nextTransition([site], {}, saturday(3))).toBe(saturday(6).getTime());
    });

    it("picks the soonest moment across sites and unblocks", () => {
        const now = friday(12);
        const scheduled = { ...always, id: "s2", ruleId: 2, domain: "youtube.com", schedule: { start: "13:00", end: "18:00", days: [] } };
        const expiry = now.getTime() + 10 * 60_000; // 12:10, before 13:00
        expect(SETTINGS.nextTransition([always, scheduled], { "facebook.com": expiry }, now)).toBe(expiry);
    });
});

describe("blocked sites CRUD", () => {
    it("addSite normalizes the domain and assigns increasing rule ids", async () => {
        const first = await SETTINGS.addSite("https://www.Facebook.com/feed");
        const second = await SETTINGS.addSite("reddit.com");

        expect(first).toMatchObject({ domain: "facebook.com", ruleId: 1, enabled: true, schedule: null });
        expect(second).toMatchObject({ domain: "reddit.com", ruleId: 2 });
        expect(storedSites().map((s) => s.domain)).toEqual(["facebook.com", "reddit.com"]);
    });

    it("rejects a domain that is already in the list, however it is written", async () => {
        await SETTINGS.addSite("facebook.com");
        await expect(SETTINGS.addSite("https://www.facebook.com/")).rejects.toThrow("facebook.com is already in the list");
        expect(storedSites()).toHaveLength(1);
    });

    it("never reuses a rule id, even after the site with the highest id is removed", async () => {
        await SETTINGS.addSite("facebook.com");
        const reddit = await SETTINGS.addSite("reddit.com");
        await SETTINGS.removeSite(reddit.id);
        const twitter = await SETTINGS.addSite("x.com");

        expect(twitter.ruleId).toBe(3);
    });

    it("removeSite deletes the entry", async () => {
        const site = await SETTINGS.addSite("facebook.com");
        await SETTINGS.removeSite(site.id);
        expect(storedSites()).toEqual([]);
    });

    it("toggleSite flips enabled without losing the schedule", async () => {
        const site = await SETTINGS.addSite("facebook.com");
        await SETTINGS.setSchedule(site.id, { start: "13:00", end: "18:00", days: [5] });
        await SETTINGS.toggleSite(site.id, false);

        expect(storedSites()[0]).toMatchObject({
            enabled: false,
            schedule: { start: "13:00", end: "18:00", days: [5] },
        });
    });

    it("setSchedule validates and normalizes; null clears back to always blocked", async () => {
        const site = await SETTINGS.addSite("facebook.com");
        await SETTINGS.setSchedule(site.id, { start: "9:00", end: "17:00", days: [6, 5] });
        expect(storedSites()[0].schedule).toEqual({ start: "09:00", end: "17:00", days: [5, 6] });

        await expect(SETTINGS.setSchedule(site.id, { start: "9:00", end: "9:00", days: [] })).rejects.toThrow(
            "Start and end times must be different"
        );
        expect(storedSites()[0].schedule).toEqual({ start: "09:00", end: "17:00", days: [5, 6] }); // unchanged

        await SETTINGS.setSchedule(site.id, null);
        expect(storedSites()[0].schedule).toBeNull();
    });

    it("operations on a removed site fail with a readable message", async () => {
        const site = await SETTINGS.addSite("facebook.com");
        await SETTINGS.removeSite(site.id);
        await expect(SETTINGS.toggleSite(site.id, false)).rejects.toThrow("That site is no longer in the list");
    });

    it("loadBlockedSites returns [] when nothing is stored, without writing", async () => {
        expect(await SETTINGS.loadBlockedSites()).toEqual([]);
        expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

});

describe("settings and toggles", () => {
    it("defaults to hiding Shorts and Reels with no PIN", async () => {
        expect(await SETTINGS.loadSettings()).toEqual({
            hideShortsReels: { youtubeShorts: true, facebookReels: true },
            pinHash: null,
        });
    });

    it("setHideToggle persists one toggle and leaves the other alone", async () => {
        await SETTINGS.setHideToggle("youtubeShorts", false);
        expect((await SETTINGS.loadSettings()).hideShortsReels).toEqual({ youtubeShorts: false, facebookReels: true });
    });

    it("rejects unknown toggles", () => {
        expect(() => SETTINGS.setHideToggle("tiktok", false)).toThrow('Unknown toggle "tiktok"');
    });
});

describe("unblock PIN", () => {
    it("stores a hash, not the PIN, and verifies it", async () => {
        await SETTINGS.setPin("1234");
        expect(storedSettings().pinHash).toMatch(/^[0-9a-f]{64}$/);
        expect(chrome.__syncData[SETTINGS_KEY]).not.toContain("1234");

        expect(await SETTINGS.verifyPin("1234")).toBe(true);
        expect(await SETTINGS.verifyPin(" 1234 ")).toBe(true); // trimmed like setPin
        expect(await SETTINGS.verifyPin("9999")).toBe(false);
    });

    it("rejects a PIN shorter than 4 characters", async () => {
        await expect(SETTINGS.setPin(" 12 ")).rejects.toThrow("Use at least 4 characters");
        expect(chrome.__syncData[SETTINGS_KEY]).toBeUndefined();
    });

    it("verifyPin is false when no PIN is set", async () => {
        expect(await SETTINGS.verifyPin("anything")).toBe(false);
    });

    it("clearPin removes the hash and any active temporary unblocks", async () => {
        await SETTINGS.setPin("1234");
        await SETTINGS.grantTempUnblock("facebook.com", 30);

        await SETTINGS.clearPin();

        expect(storedSettings().pinHash).toBeNull();
        expect(storedUnblocks()).toEqual({});
        expect(await SETTINGS.verifyPin("1234")).toBe(false);
    });
});

describe("temporary unblocks", () => {
    it("grantTempUnblock stores now + minutes in local storage", async () => {
        const now = 1_800_000_000_000;
        const expiry = await SETTINGS.grantTempUnblock("facebook.com", 15, now);

        expect(expiry).toBe(now + 15 * 60_000);
        expect(storedUnblocks()).toEqual({ "facebook.com": expiry });
        expect(chrome.storage.sync.set).not.toHaveBeenCalled(); // per device on purpose
    });

    it("rejects a missing or non-positive duration", async () => {
        await expect(SETTINGS.grantTempUnblock("facebook.com", 0)).rejects.toThrow("Choose how long to unblock for");
        await expect(SETTINGS.grantTempUnblock("facebook.com", undefined)).rejects.toThrow();
    });

    it("getTempUnblocks drops expired entries and persists the pruning", async () => {
        const now = 1_800_000_000_000;
        await SETTINGS.grantTempUnblock("facebook.com", 15, now);
        await SETTINGS.grantTempUnblock("reddit.com", 30, now);

        const later = now + 20 * 60_000; // facebook expired, reddit still running
        expect(await SETTINGS.getTempUnblocks(later)).toEqual({ "reddit.com": now + 30 * 60_000 });
        expect(storedUnblocks()).toEqual({ "reddit.com": now + 30 * 60_000 });
    });

    it("granting again extends an existing unblock", async () => {
        const now = 1_800_000_000_000;
        await SETTINGS.grantTempUnblock("facebook.com", 5, now);
        await SETTINGS.grantTempUnblock("facebook.com", 60, now);

        expect(storedUnblocks()).toEqual({ "facebook.com": now + 60 * 60_000 });
    });

    it("treats corrupt stored values as empty", async () => {
        chrome.__storageData[TEMP_UNBLOCKS_KEY] = "{not json";
        expect(await SETTINGS.getTempUnblocks()).toEqual({});
    });
});
