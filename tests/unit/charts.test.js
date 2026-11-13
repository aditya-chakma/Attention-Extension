import { describe, it, expect } from "vitest";
import { statCard, stackedBarChart, lineChart, rankedBars, calendarHeatmap } from "../../charts.js";

describe("statCard", () => {
    it("shows label, value and sub text", () => {
        const card = statCard({ label: "Screen time", value: "1h 05m", sub: "on watched sites" });
        expect(card.querySelector(".stat-label").textContent).toBe("Screen time");
        expect(card.querySelector(".stat-value").textContent).toBe("1h 05m");
        expect(card.querySelector(".stat-sub").textContent).toBe("on watched sites");
        expect(card.querySelector(".stat-trend")).toBeNull();
    });

    it.each([
        [{ direction: "down", good: true }, "▼", "good"],
        [{ direction: "up", good: false }, "▲", "bad"],
        [{ direction: "up", good: null }, "▲", "neutral"],
    ])("draws the trend %j", (trend, arrow, tone) => {
        const card = statCard({ label: "x", value: "1", trend: { ...trend, text: "12% vs previous" } });
        const line = card.querySelector(".stat-trend");
        expect(line.classList.contains(tone)).toBe(true);
        expect(line.textContent).toContain(arrow);
        expect(line.textContent).toContain("12% vs previous");
    });

    it("never interprets values as markup", () => {
        const card = statCard({ label: "<img src=x>", value: "<script>alert(1)</script>" });
        expect(card.querySelector("img, script")).toBeNull();
    });
});

describe("stackedBarChart", () => {
    const chart = () =>
        stackedBarChart({
            days: [
                { label: "Nov 10", parts: [{ key: "shorts", value: 3 }, { key: "reels", value: 1 }] },
                { label: "Nov 11", parts: [{ key: "shorts", value: 0 }, { key: "reels", value: 0 }] },
                { label: "Nov 12", parts: [{ key: "shorts", value: 8 }, { key: "reels", value: 0 }] },
            ],
        });

    it("draws one segment per non-zero part, keyed by CSS class", () => {
        const svg = chart().querySelector("svg");
        expect(svg.querySelectorAll(".chart-part-shorts")).toHaveLength(2);
        expect(svg.querySelectorAll(".chart-part-reels")).toHaveLength(1);
        expect(svg.querySelectorAll(".chart-part-empty")).toHaveLength(1); // the all-zero day
    });

    it("scales bars to the largest day and labels the axes", () => {
        const wrap = chart();
        expect(wrap.querySelector(".chart-y-max").textContent).toBe("8");
        const labels = [...wrap.querySelectorAll(".chart-x-axis span")].map((s) => s.textContent);
        expect(labels).toEqual(["Nov 10", "Nov 11", "Nov 12"]);
        const heights = [...wrap.querySelectorAll(".chart-part-shorts")].map((r) => Number(r.getAttribute("height")));
        expect(heights[1]).toBeCloseTo(heights[0] * (8 / 3), 5);
    });

    it("puts the day's numbers in a tooltip", () => {
        const titles = [...chart().querySelectorAll("svg g title")].map((t) => t.textContent);
        expect(titles[0]).toBe("Nov 10: 3 shorts, 1 reels");
    });
});

describe("lineChart", () => {
    const chart = () =>
        lineChart({
            points: [
                { label: "Nov 10", value: 0 },
                { label: "Nov 11", value: 600 },
                { label: "Nov 12", value: 300 },
            ],
            formatValue: (v) => `${v}s`,
        });

    it("draws the line, the filled area and one hover tooltip per day", () => {
        const wrap = chart();
        expect(wrap.querySelector("polyline.chart-line")).not.toBeNull();
        expect(wrap.querySelector("polygon.chart-area")).not.toBeNull();
        const titles = [...wrap.querySelectorAll(".chart-hover title")].map((t) => t.textContent);
        expect(titles).toEqual(["Nov 10: 0s", "Nov 11: 600s", "Nov 12: 300s"]);
    });

    it("shows the maximum on the y-axis", () => {
        expect(chart().querySelector(".chart-y-max").textContent).toBe("600s");
    });

    it("copes with a single point and with all zeros", () => {
        expect(lineChart({ points: [{ label: "x", value: 0 }] }).querySelector("polyline")).not.toBeNull();
        const flat = lineChart({ points: [{ label: "a", value: 0 }, { label: "b", value: 0 }] });
        expect(flat.querySelector(".chart-y-max").textContent).toBe("1"); // max is clamped, no NaN anywhere
        expect(flat.querySelector("polyline").getAttribute("points")).not.toContain("NaN");
    });
});

describe("rankedBars", () => {
    it("sizes bars relative to the leader and shows values with subs", () => {
        const list = rankedBars({
            entries: [
                { label: "reddit.com", value: 10 },
                { label: "x.com", value: 5, sub: " · 1 unblock" },
            ],
        });
        const fills = [...list.querySelectorAll(".ranked-fill")].map((f) => f.style.width);
        expect(fills).toEqual(["100%", "50%"]);
        expect(list.querySelectorAll(".ranked-label")[0].textContent).toBe("reddit.com");
        expect(list.querySelectorAll(".ranked-value")[1].textContent).toBe("5 · 1 unblock");
    });

    it("shows the empty text when there are no entries", () => {
        const list = rankedBars({ entries: [], emptyText: "No blocked visits in this period" });
        expect(list.querySelector(".chart-empty").textContent).toBe("No blocked visits in this period");
    });
});

describe("calendarHeatmap", () => {
    // 2026-11-08 is a Sunday
    const days = Array.from({ length: 14 }, (_, i) => ({
        day: `2026-11-${String(8 + i).padStart(2, "0")}`,
        label: `Nov ${8 + i}`,
        value: i === 3 ? 3600000 : i === 4 ? 900000 : 0,
    }));

    it("draws one cell per day with intensity levels and tooltips", () => {
        const grid = calendarHeatmap({ days, formatValue: (v) => `${v / 60000}m` }).querySelector(".heatmap-grid");
        const cells = grid.querySelectorAll(".heatmap-cell:not(.pad)");
        expect(cells).toHaveLength(14);
        expect(cells[3].className).toBe("heatmap-cell level-4"); // the maximum
        expect(cells[4].className).toBe("heatmap-cell level-1"); // a quarter of it: the first quartile
        expect(cells[0].className).toBe("heatmap-cell level-0");
        expect(cells[3].title).toBe("Nov 11: 60m");
        expect(grid.style.gridTemplateColumns).toContain("repeat(2,"); // two whole weeks
    });

    it("pads the first column so weekdays line up", () => {
        // 2026-11-10 is a Tuesday: two pad cells (Sunday, Monday) before it
        const offset = calendarHeatmap({ days: days.slice(2) });
        expect(offset.querySelectorAll(".heatmap-cell.pad")).toHaveLength(2);
    });
});
