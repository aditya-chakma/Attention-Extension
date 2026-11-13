import { describe, it, expect, beforeAll } from "vitest";

let STATS;

beforeAll(async () => {
    await import("../../statsStore.js");
    STATS = globalThis.ATTENTION_STATS;
});

const DAY_PREFIX = "attention_stats_day_";
const META_KEY = "attention_stats_meta";

const stored = (day) => JSON.parse(chrome.__storageData[DAY_PREFIX + day]);
const seedDay = (day, record) => {
    chrome.__storageData[DAY_PREFIX + day] = JSON.stringify(record);
};
const seedMeta = (meta) => {
    chrome.__storageData[META_KEY] = JSON.stringify(meta);
};

// Thursday 12 November 2026, mid-afternoon local time
const today = (hours = 15) => new Date(2026, 10, 12, hours);

describe("dayKey and lastDays", () => {
    it("formats the local date", () => {
        expect(STATS.dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
        expect(STATS.dayKey(new Date(2026, 10, 12, 0, 0))).toBe("2026-11-12");
    });

    it("lists days oldest first, ending today, across month and year boundaries", () => {
        expect(STATS.lastDays(3, new Date(2026, 2, 1))).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
        expect(STATS.lastDays(2, new Date(2027, 0, 1))).toEqual(["2026-12-31", "2027-01-01"]);
    });

    it("yields one key per calendar day across a DST change", () => {
        // Covers both the March and November transitions in any time zone that has them
        const days = STATS.lastDays(366, new Date(2026, 11, 31));
        expect(new Set(days).size).toBe(366);
        expect(days[0]).toBe("2025-12-31");
    });
});

describe("isStatsKey", () => {
    it.each([
        ["attention_stats_day_2026-11-12", true],
        ["attention_stats_meta", true],
        ["attention_stats_day_", false],
        ["attention_settings", false],
        ["attention_bookmarked_videos", false],
        ["dQw4w9WgXcQ", false],
    ])("%s -> %s", (key, expected) => {
        expect(STATS.isStatsKey(key)).toBe(expected);
    });
});

describe("validateEvent", () => {
    it("accepts and normalizes each event type", () => {
        expect(STATS.validateEvent({ event: "removal", kind: "shorts", count: 3 })).toEqual({
            event: "removal",
            kind: "shorts",
            count: 3,
        });
        expect(STATS.validateEvent({ event: "redirect", kind: "reels", extra: 1 })).toEqual({
            event: "redirect",
            kind: "reels",
        });
        expect(STATS.validateEvent({ event: "blockedVisit", domain: "reddit.com" })).toEqual({
            event: "blockedVisit",
            domain: "reddit.com",
        });
        expect(STATS.validateEvent({ event: "unblock", domain: "reddit.com", minutes: 15 })).toEqual({
            event: "unblock",
            domain: "reddit.com",
            minutes: 15,
        });
        expect(STATS.validateEvent({ event: "screenTime", domain: "youtube.com", ms: 1500.4 })).toEqual({
            event: "screenTime",
            domain: "youtube.com",
            ms: 1500,
        });
    });

    it("caps absurd values", () => {
        expect(STATS.validateEvent({ event: "removal", kind: "shorts", count: 1e9 }).count).toBe(1000);
        expect(STATS.validateEvent({ event: "unblock", domain: "a.com", minutes: 1e6 }).minutes).toBe(1440);
    });

    it.each([
        null,
        "removal",
        {},
        { event: "nope" },
        { event: "removal", kind: "tiktok", count: 1 },
        { event: "removal", kind: "shorts", count: 0 },
        { event: "removal", kind: "shorts", count: -2 },
        { event: "removal", kind: "shorts", count: 1.5 },
        { event: "removal", kind: "shorts", count: "3" },
        { event: "redirect" },
        { event: "blockedVisit", domain: "" },
        { event: "blockedVisit", domain: "Reddit.com" },
        { event: "blockedVisit", domain: "<script>" },
        { event: "blockedVisit", domain: 42 },
        { event: "unblock", domain: "a.com", minutes: 0 },
        { event: "screenTime", domain: "a.com", ms: 0 },
        { event: "screenTime", domain: "a.com", ms: NaN },
    ])("rejects %j", (event) => {
        expect(() => STATS.validateEvent(event)).toThrow(/Invalid stats event/);
    });
});

describe("applyEvent", () => {
    it("adds each event to a day record without mutating the input", () => {
        const start = { shortsRemoved: 2 };
        let day = STATS.applyEvent(start, { event: "removal", kind: "shorts", count: 3 });
        day = STATS.applyEvent(day, { event: "removal", kind: "reels", count: 1 });
        day = STATS.applyEvent(day, { event: "redirect", kind: "shorts" });
        day = STATS.applyEvent(day, { event: "redirect", kind: "reels" });
        day = STATS.applyEvent(day, { event: "blockedVisit", domain: "reddit.com" });
        day = STATS.applyEvent(day, { event: "blockedVisit", domain: "reddit.com" });
        day = STATS.applyEvent(day, { event: "unblock", domain: "reddit.com", minutes: 15 });
        day = STATS.applyEvent(day, { event: "unblock", domain: "reddit.com", minutes: 5 });
        day = STATS.applyEvent(day, { event: "screenTime", domain: "youtube.com", ms: 60000 });
        day = STATS.applyEvent(day, { event: "screenTime", domain: "youtube.com", ms: 30000 });

        expect(start).toEqual({ shortsRemoved: 2 });
        expect(day).toEqual({
            shortsRemoved: 5,
            reelsRemoved: 1,
            shortsRedirects: 1,
            reelsRedirects: 1,
            blockedVisits: { "reddit.com": 2 },
            unblocks: { "reddit.com": { count: 2, minutes: 20 } },
            screenTimeMs: { "youtube.com": 90000 },
        });
    });

    it("starts from an empty record when there is none or it is damaged", () => {
        for (const start of [null, undefined, "garbage", { shortsRemoved: "x", blockedVisits: 5 }]) {
            const day = STATS.applyEvent(start, { event: "blockedVisit", domain: "a.com" });
            expect(day.shortsRemoved).toBe(0);
            expect(day.blockedVisits).toEqual({ "a.com": 1 });
        }
    });
});

describe("aggregation", () => {
    const days = {
        "2026-11-10": {
            shortsRemoved: 4,
            blockedVisits: { "reddit.com": 3, "x.com": 1 },
            unblocks: { "reddit.com": { count: 1, minutes: 15 } },
            screenTimeMs: { "youtube.com": 600000 },
        },
        "2026-11-12": {
            reelsRemoved: 2,
            shortsRedirects: 1,
            blockedVisits: { "x.com": 5 },
            screenTimeMs: { "youtube.com": 300000, "facebook.com": 120000 },
        },
    };

    it("summarize adds up totals and per-site maps", () => {
        const { totals, perSite } = STATS.summarize(days);
        expect(totals).toEqual({
            shortsRemoved: 4,
            reelsRemoved: 2,
            shortsRedirects: 1,
            reelsRedirects: 0,
            blockedVisits: 9,
            unblocks: 1,
            unblockMinutes: 15,
            screenTimeMs: 1020000,
        });
        expect(perSite.blockedVisits).toEqual({ "reddit.com": 3, "x.com": 6 });
        expect(perSite.unblocks).toEqual({ "reddit.com": 1 });
        expect(perSite.unblockMinutes).toEqual({ "reddit.com": 15 });
        expect(perSite.screenTimeMs).toEqual({ "youtube.com": 900000, "facebook.com": 120000 });
    });

    it("summarize of nothing is all zeros", () => {
        const { totals } = STATS.summarize({});
        expect(Object.values(totals).every((n) => n === 0)).toBe(true);
    });

    it("dailySeries fills missing days with zero, in the requested order", () => {
        const keys = ["2026-11-10", "2026-11-11", "2026-11-12"];
        expect(STATS.dailySeries(days, keys, (t) => t.blockedVisits)).toEqual([
            { day: "2026-11-10", value: 4 },
            { day: "2026-11-11", value: 0 },
            { day: "2026-11-12", value: 5 },
        ]);
        expect(STATS.dailySeries(days, keys, (t, record) => record.screenTimeMs["youtube.com"] ?? 0)).toEqual([
            { day: "2026-11-10", value: 600000 },
            { day: "2026-11-11", value: 0 },
            { day: "2026-11-12", value: 300000 },
        ]);
    });

    it("topEntries ranks largest first, ties alphabetically, and drops zeros", () => {
        const map = { "b.com": 3, "a.com": 3, "c.com": 9, "d.com": 0, "e.com": 1 };
        expect(STATS.topEntries(map, 3)).toEqual([
            { domain: "c.com", value: 9 },
            { domain: "a.com", value: 3 },
            { domain: "b.com", value: 3 },
        ]);
        expect(STATS.topEntries({})).toEqual([]);
    });

    it("estimateTimeSavedMs weighs each kind of event", () => {
        const totals = {
            blockedVisits: 2, // 2 x 10 min
            shortsRedirects: 1, // 1 x 5 min
            reelsRedirects: 1, // 1 x 5 min
            shortsRemoved: 3, // 3 x 1 min
            reelsRemoved: 2, // 2 x 1 min
        };
        expect(STATS.estimateTimeSavedMs(totals)).toBe(35 * 60 * 1000);
    });
});

describe("focusStreak", () => {
    const now = today();
    const unblockedOn = { unblocks: { "reddit.com": { count: 1, minutes: 5 } } };

    it("is 0 before anything was tracked", () => {
        expect(STATS.focusStreak({}, null, now)).toBe(0);
    });

    it("counts today when tracking started today and it is clean", () => {
        expect(STATS.focusStreak({}, "2026-11-12", now)).toBe(1);
    });

    it("counts clean days back to the last unblock", () => {
        const days = { "2026-11-09": unblockedOn, "2026-11-11": { shortsRemoved: 3 } };
        // 10th, 11th and 12th are clean (days without any record are clean too)
        expect(STATS.focusStreak(days, "2026-11-01", now)).toBe(3);
    });

    it("is 0 when today already has an unblock", () => {
        expect(STATS.focusStreak({ "2026-11-12": unblockedOn }, "2026-11-01", now)).toBe(0);
    });

    it("stops at the day tracking started", () => {
        expect(STATS.focusStreak({}, "2026-11-08", now)).toBe(5);
    });

    it("never reaches beyond the given window", () => {
        expect(STATS.focusStreak({}, "2020-01-01", now, 30)).toBe(30);
    });
});

describe("record (storage)", () => {
    it("writes today's record and remembers when tracking started", async () => {
        await STATS.record({ event: "removal", kind: "shorts", count: 2 }, today());
        await STATS.record({ event: "blockedVisit", domain: "reddit.com" }, today(16));

        expect(stored("2026-11-12")).toMatchObject({ shortsRemoved: 2, blockedVisits: { "reddit.com": 1 } });
        expect(JSON.parse(chrome.__storageData[META_KEY])).toEqual({ trackingSince: "2026-11-12" });
    });

    it("keeps the original tracking start", async () => {
        seedMeta({ trackingSince: "2026-10-01" });
        await STATS.record({ event: "redirect", kind: "reels" }, today());
        expect(JSON.parse(chrome.__storageData[META_KEY])).toEqual({ trackingSince: "2026-10-01" });
    });

    it("moves the tracking start back when an earlier day is written", async () => {
        seedMeta({ trackingSince: "2026-11-01" });
        await STATS.record({ event: "redirect", kind: "reels" }, new Date(2026, 9, 20));
        expect(JSON.parse(chrome.__storageData[META_KEY])).toEqual({ trackingSince: "2026-10-20" });
    });

    it("files events under the local day they happened", async () => {
        await STATS.record({ event: "redirect", kind: "shorts" }, new Date(2026, 10, 11, 23, 59));
        await STATS.record({ event: "redirect", kind: "shorts" }, new Date(2026, 10, 12, 0, 1));
        expect(stored("2026-11-11").shortsRedirects).toBe(1);
        expect(stored("2026-11-12").shortsRedirects).toBe(1);
    });

    it("doesn't lose increments when events arrive at the same time", async () => {
        await Promise.all(
            Array.from({ length: 20 }, () => STATS.record({ event: "removal", kind: "reels", count: 1 }, today()))
        );
        expect(stored("2026-11-12").reelsRemoved).toBe(20);
    });

    it("rejects invalid events without writing anything", () => {
        expect(() => STATS.record({ event: "removal", kind: "shorts", count: -1 })).toThrow();
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("prunes days older than the retention window on the first write of a day", async () => {
        // The 180 days ending on 12 November start on 17 May
        seedDay("2026-05-16", { shortsRemoved: 1 }); // just outside: gone
        seedDay("2026-05-17", { shortsRemoved: 1 }); // the oldest kept day
        chrome.__storageData["attention_settings"] = "{}";
        chrome.__storageData["dQw4w9WgXcQ"] = "[]";

        await STATS.record({ event: "redirect", kind: "shorts" }, today());

        expect(chrome.__storageData[DAY_PREFIX + "2026-05-16"]).toBeUndefined();
        expect(chrome.__storageData[DAY_PREFIX + "2026-05-17"]).toBeDefined();
        // Other keys are never touched
        expect(chrome.__storageData["attention_settings"]).toBe("{}");
        expect(chrome.__storageData["dQw4w9WgXcQ"]).toBe("[]");
    });

    it("doesn't scan storage again for later writes on the same day", async () => {
        await STATS.record({ event: "redirect", kind: "shorts" }, today());
        chrome.storage.local.get.mockClear();
        await STATS.record({ event: "redirect", kind: "shorts" }, today());
        expect(chrome.storage.local.get).not.toHaveBeenCalledWith(null, expect.anything());
    });
});

describe("loadRange", () => {
    it("returns the selected days, the period before them and the streak", async () => {
        seedMeta({ trackingSince: "2026-11-01" });
        seedDay("2026-11-12", { blockedVisits: { "x.com": 2 } });
        seedDay("2026-11-06", { shortsRemoved: 7 }); // inside the current 7 days
        seedDay("2026-11-05", { unblocks: { "x.com": { count: 1, minutes: 5 } } }); // previous period
        seedDay("2026-10-29", { shortsRemoved: 9 }); // before both periods

        const range = await STATS.loadRange(7, today());

        expect(range.dayKeys).toEqual(STATS.lastDays(7, today()));
        expect(Object.keys(range.days).sort()).toEqual(["2026-11-06", "2026-11-12"]);
        expect(Object.keys(range.previousDays)).toEqual(["2026-11-05"]);
        expect(range.trackingSince).toBe("2026-11-01");
        // 6th to 12th are clean; the 5th had an unblock
        expect(range.focusStreak).toBe(7);
    });

    it("works with no statistics at all", async () => {
        const range = await STATS.loadRange(30, today());
        expect(range.dayKeys).toHaveLength(30);
        expect(range.days).toEqual({});
        expect(range.previousDays).toEqual({});
        expect(range.trackingSince).toBeNull();
        expect(range.focusStreak).toBe(0);
    });

    it("ignores unreadable day records", async () => {
        chrome.__storageData[DAY_PREFIX + "2026-11-12"] = "not json";
        const range = await STATS.loadRange(7, today());
        expect(STATS.summarize(range.days).totals.blockedVisits).toBe(0);
    });
});

describe("clearStats", () => {
    it("removes every statistic and nothing else", async () => {
        seedMeta({ trackingSince: "2026-11-01" });
        seedDay("2026-11-12", { shortsRemoved: 1 });
        chrome.__storageData["attention_temp_unblocks"] = "{}";
        chrome.__storageData["dQw4w9WgXcQ"] = "[]";

        await STATS.clearStats();

        expect(Object.keys(chrome.__storageData).sort()).toEqual(["attention_temp_unblocks", "dQw4w9WgXcQ"]);
    });
});
