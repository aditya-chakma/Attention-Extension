import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushPromises } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const body = fs.readFileSync(path.join(root, "insights.html"), "utf8").match(/<body>([\s\S]*)<\/body>/)[1];

// Thursday 2026-11-12 15:00 local time
const NOW = new Date(2026, 10, 12, 15, 0);
const DAY_PREFIX = "attention_stats_day_";

const seedDay = (day, record) => {
    chrome.__storageData[DAY_PREFIX + day] = JSON.stringify(record);
};
const seedMeta = (trackingSince) => {
    chrome.__storageData["attention_stats_meta"] = JSON.stringify({ trackingSince });
};

const renderPage = async () => {
    document.body.innerHTML = body;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flushPromises();
    await flushPromises();
};

const text = (selector) => document.querySelector(selector)?.textContent ?? null;
const card = (label) =>
    [...document.querySelectorAll(".stat-card")].find((c) => c.querySelector(".stat-label").textContent === label);

beforeAll(async () => {
    await import("../../insights.js");
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
});

describe("insights page: stat cards", () => {
    beforeEach(() => {
        seedMeta("2026-10-01");
        seedDay("2026-11-12", {
            shortsRemoved: 10,
            reelsRemoved: 2,
            shortsRedirects: 3,
            reelsRedirects: 1,
            blockedVisits: { "reddit.com": 4, "x.com": 1 },
            unblocks: { "reddit.com": { count: 2, minutes: 45 } },
            screenTimeMs: { "youtube.com": 3600000, "facebook.com": 300000 },
        });
        // Previous period (the 7 days before 2026-11-06..12): more of everything
        seedDay("2026-11-03", {
            shortsRemoved: 20,
            blockedVisits: { "reddit.com": 10 },
            screenTimeMs: { "youtube.com": 7200000 },
            unblocks: { "reddit.com": { count: 4, minutes: 60 } },
        });
    });

    it("shows the headline numbers for the selected period", async () => {
        await renderPage();

        expect(card("Screen time").querySelector(".stat-value").textContent).toBe("1h 5m");
        expect(card("Blocked visits").querySelector(".stat-value").textContent).toBe("5");
        expect(card("Shorts & Reels blocked").querySelector(".stat-value").textContent).toBe("16");
        expect(card("Shorts & Reels blocked").querySelector(".stat-sub").textContent).toBe("13 Shorts, 3 Reels");
        expect(card("Temporary unblocks").querySelector(".stat-value").textContent).toBe("2");
        expect(card("Temporary unblocks").querySelector(".stat-sub").textContent).toBe("45m unblocked");
    });

    it("estimates time saved from blocks, redirects and removals", async () => {
        await renderPage();

        // 5 visits x 10m + 4 redirects x 5m + 12 removals x 1m = 82m
        expect(card("Time saved (estimate)").querySelector(".stat-value").textContent).toBe("1h 22m");
    });

    it("compares against the period before with a tone: less screen time is good", async () => {
        await renderPage();

        const screenTrend = card("Screen time").querySelector(".stat-trend");
        expect(screenTrend.classList.contains("good")).toBe(true);
        expect(screenTrend.textContent).toContain("46% vs previous 7 days (2h 0m)");

        const blockedTrend = card("Blocked visits").querySelector(".stat-trend");
        expect(blockedTrend.classList.contains("good")).toBe(true);

        // Shorts & Reels blocked has no better direction: neutral
        expect(card("Shorts & Reels blocked").querySelector(".stat-trend").classList.contains("neutral")).toBe(true);
    });

    it("counts the focus streak back from today (unblocked today: 0 days)", async () => {
        await renderPage();

        expect(card("Focus streak").querySelector(".stat-value").textContent).toBe("0 days");
    });
});

describe("insights page: charts", () => {
    beforeEach(() => {
        seedMeta("2026-10-01");
        seedDay("2026-11-10", {
            shortsRemoved: 4,
            reelsRemoved: 2,
            blockedVisits: { "reddit.com": 3, "x.com": 1, "a.com": 1, "b.com": 1, "c.com": 1, "d.com": 1 },
            screenTimeMs: { "youtube.com": 1800000 },
            unblocks: { "reddit.com": { count: 1, minutes: 15 } },
        });
        seedDay("2026-11-12", { shortsRedirects: 1, screenTimeMs: { "youtube.com": 600000 } });
    });

    it("draws the screen time line with one point per day of the range", async () => {
        await renderPage();

        const chart = document.querySelector("#screen-time-chart");
        expect(chart.querySelectorAll(".chart-hover")).toHaveLength(7);
        const titles = [...chart.querySelectorAll(".chart-hover title")].map((t) => t.textContent);
        expect(titles).toContain("Nov 10: 30m");
        expect(titles).toContain("Nov 12: 10m");
    });

    it("stacks removed and redirected Shorts/Reels per day", async () => {
        await renderPage();

        const chart = document.querySelector("#shorts-reels-chart");
        expect(chart.querySelectorAll(".chart-part-shorts")).toHaveLength(2); // Nov 10 and Nov 12
        expect(chart.querySelectorAll(".chart-part-reels")).toHaveLength(1);
        const titles = [...chart.querySelectorAll("svg g title")].map((t) => t.textContent);
        expect(titles).toContain("Nov 10: 4 shorts, 2 reels");
    });

    it("ranks the top 5 blocked sites with their unblocks", async () => {
        await renderPage();

        const rows = document.querySelectorAll("#top-sites-chart .ranked-row");
        expect(rows).toHaveLength(5);
        expect(rows[0].querySelector(".ranked-label").textContent).toBe("reddit.com");
        expect(rows[0].querySelector(".ranked-value").textContent).toBe("3 · 1 unblock");
    });

    it("draws 13 weeks of screen time in the calendar", async () => {
        await renderPage();

        const cells = document.querySelectorAll("#heatmap-chart .heatmap-cell:not(.pad)");
        expect(cells).toHaveLength(91);
        expect([...cells].filter((c) => !c.className.includes("level-0"))).toHaveLength(2);
    });
});

describe("insights page: ranges and live updates", () => {
    it("marks 7 days active by default and re-renders for a new range", async () => {
        seedMeta("2026-10-01");
        seedDay("2026-10-20", { blockedVisits: { "reddit.com": 7 } }); // outside 7d, inside 30d
        await renderPage();

        expect(document.querySelector('.range-btn[data-days="7"]').classList.contains("active")).toBe(true);
        expect(card("Blocked visits").querySelector(".stat-value").textContent).toBe("0");

        document.querySelector('.range-btn[data-days="30"]').click();
        await flushPromises();

        expect(document.querySelector('.range-btn[data-days="30"]').classList.contains("active")).toBe(true);
        expect(card("Blocked visits").querySelector(".stat-value").textContent).toBe("7");
        expect(document.querySelectorAll("#screen-time-chart .chart-hover")).toHaveLength(30);
    });

    it("says when nothing has been measured yet", async () => {
        await renderPage();

        const note = document.getElementById("insights-note");
        expect(note.hidden).toBe(false);
        expect(note.textContent).toContain("Nothing measured yet");
    });

    it("says when statistics start inside the selected range", async () => {
        seedMeta("2026-11-10");
        seedDay("2026-11-10", { shortsRemoved: 1 });
        await renderPage();

        expect(text("#insights-note")).toBe("Statistics start Nov 10.");
    });

    it("re-renders when the worker writes a statistic, coalescing bursts", async () => {
        // Fake setTimeout too (the debounce): flushPromises would hang, so
        // this test advances the fake clock instead
        vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
        vi.setSystemTime(NOW);
        seedMeta("2026-10-01");
        document.body.innerHTML = body;
        document.dispatchEvent(new Event("DOMContentLoaded"));
        await vi.advanceTimersByTimeAsync(1);
        expect(card("Blocked visits").querySelector(".stat-value").textContent).toBe("0");

        // Two writes in one burst, as the worker does
        seedDay("2026-11-12", { blockedVisits: { "reddit.com": 2 } });
        chrome.storage.local.set({ [DAY_PREFIX + "2026-11-12"]: chrome.__storageData[DAY_PREFIX + "2026-11-12"] });
        chrome.storage.local.set({ attention_stats_meta: JSON.stringify({ trackingSince: "2026-10-01" }) });

        await vi.advanceTimersByTimeAsync(250);

        expect(card("Blocked visits").querySelector(".stat-value").textContent).toBe("2");
    });

    it("ignores unrelated storage changes", async () => {
        await renderPage();
        const before = document.getElementById("stat-cards").innerHTML;

        chrome.storage.local.set({ attention_bookmarked_videos: "[]" });
        await flushPromises();

        expect(document.getElementById("stat-cards").innerHTML).toBe(before);
    });
});
