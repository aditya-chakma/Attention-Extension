// The Insights page: what the extension blocked and where screen time went,
// over the last 7/30/90 days, drawn with charts.js from statsStore.js data.
// Re-renders live when the background worker writes new statistics.
import "./icons.js";
import "./statsStore.js";
import { statCard, stackedBarChart, lineChart, rankedBars, calendarHeatmap } from "./charts.js";

const STATS = globalThis.ATTENTION_STATS;

const RANGES = [7, 30, 90];
const DEFAULT_RANGE = 7;
const HEATMAP_DAYS = 91; // 13 whole weeks
const TOP_SITES = 5;

let rangeDays = DEFAULT_RANGE;

// ---- Formatting --------------------------------------------------------------

const count = (n) => n.toLocaleString();

/** 5445000 -> "1h 31m"; sub-minute times show seconds so small data isn't "0m". */
const duration = (ms) => {
    const minutes = Math.round(ms / 60000);
    if (minutes === 0) return ms >= 1000 ? `${Math.round(ms / 1000)}s` : "0m";
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// "2026-11-05" -> "Nov 5" (keys are local dates; avoid the UTC Date("...") parse)
const dayLabel = (key) => {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

// ---- Trends ------------------------------------------------------------------

/**
 * Trend vs the period before: { text, direction, good } or null when there is
 * nothing to compare. `goodWhen` is "down" (less is better), "up", or null
 * (neither is better: the arrow stays neutral).
 */
const trendFor = (current, previous, goodWhen, format = count) => {
    if (previous <= 0 || current === previous) return null;
    const direction = current > previous ? "up" : "down";
    const good = goodWhen === null ? null : direction === goodWhen;
    const change = Math.round(Math.abs((current - previous) / previous) * 100);
    if (change === 0) return null;
    return { direction, good, text: `${change}% vs previous ${rangeDays} days (${format(previous)})` };
};

// ---- Sections ----------------------------------------------------------------

const show = (id, element) => {
    const host = document.getElementById(id);
    host.replaceChildren(element);
};

const renderCards = (range) => {
    const { totals } = STATS.summarize(range.days);
    const previous = STATS.summarize(range.previousDays).totals;
    const cards = document.getElementById("stat-cards");
    cards.replaceChildren();

    const shortsReels = totals.shortsRemoved + totals.reelsRemoved + totals.shortsRedirects + totals.reelsRedirects;
    const previousShortsReels =
        previous.shortsRemoved + previous.reelsRemoved + previous.shortsRedirects + previous.reelsRedirects;

    cards.append(
        statCard({
            label: "Time saved (estimate)",
            value: duration(STATS.estimateTimeSavedMs(totals)),
            sub: "from blocks and redirects",
            trend: trendFor(STATS.estimateTimeSavedMs(totals), STATS.estimateTimeSavedMs(previous), "up", duration),
        }),
        statCard({
            label: "Screen time",
            value: duration(totals.screenTimeMs),
            sub: "on watched sites",
            trend: trendFor(totals.screenTimeMs, previous.screenTimeMs, "down", duration),
        }),
        statCard({
            label: "Blocked visits",
            value: count(totals.blockedVisits),
            sub: "attempts stopped",
            trend: trendFor(totals.blockedVisits, previous.blockedVisits, "down"),
        }),
        statCard({
            label: "Shorts & Reels blocked",
            value: count(shortsReels),
            sub: `${count(totals.shortsRemoved + totals.shortsRedirects)} Shorts, ${count(
                totals.reelsRemoved + totals.reelsRedirects
            )} Reels`,
            trend: trendFor(shortsReels, previousShortsReels, null),
        }),
        statCard({
            label: "Temporary unblocks",
            value: count(totals.unblocks),
            sub: totals.unblocks > 0 ? `${duration(totals.unblockMinutes * 60000)} unblocked` : "none in this period",
            trend: trendFor(totals.unblocks, previous.unblocks, "down"),
        }),
        statCard({
            label: "Focus streak",
            value: plural(range.focusStreak, "day"),
            sub: "without a temporary unblock",
        })
    );
};

const renderScreenTime = (range) => {
    const series = STATS.dailySeries(range.days, range.dayKeys, (totals) => totals.screenTimeMs);
    show(
        "screen-time-chart",
        lineChart({
            points: series.map(({ day, value }) => ({ label: dayLabel(day), value })),
            formatValue: duration,
            ariaLabel: "Screen time per day",
        })
    );
};

const renderShortsReels = (range) => {
    const shorts = STATS.dailySeries(range.days, range.dayKeys, (t) => t.shortsRemoved + t.shortsRedirects);
    const reels = STATS.dailySeries(range.days, range.dayKeys, (t) => t.reelsRemoved + t.reelsRedirects);
    show(
        "shorts-reels-chart",
        stackedBarChart({
            days: range.dayKeys.map((day, i) => ({
                label: dayLabel(day),
                parts: [
                    { key: "shorts", value: shorts[i].value },
                    { key: "reels", value: reels[i].value },
                ],
            })),
            formatValue: count,
            ariaLabel: "Shorts and Reels blocked per day",
        })
    );
};

const renderTopSites = (range) => {
    const { perSite } = STATS.summarize(range.days);
    const entries = STATS.topEntries(perSite.blockedVisits, TOP_SITES).map(({ domain, value }) => ({
        label: domain,
        value,
        sub: perSite.unblocks[domain] ? ` · ${plural(perSite.unblocks[domain], "unblock")}` : "",
    }));
    show(
        "top-sites-chart",
        rankedBars({ entries, formatValue: count, emptyText: "No blocked visits in this period" })
    );
};

const renderHeatmap = async () => {
    const dayKeys = STATS.lastDays(HEATMAP_DAYS);
    const days = await STATS.loadDays(dayKeys);
    show(
        "heatmap-chart",
        calendarHeatmap({
            days: dayKeys.map((day) => ({
                day,
                label: dayLabel(day),
                value: STATS.dayTotals(days[day]).screenTimeMs,
            })),
            formatValue: duration,
        })
    );
};

const renderNote = (range) => {
    const note = document.getElementById("insights-note");
    if (!range.trackingSince) {
        note.textContent = "Nothing measured yet. Numbers appear as you browse with Attention on.";
        note.hidden = false;
    } else if (range.trackingSince > range.dayKeys[0]) {
        note.textContent = `Statistics start ${dayLabel(range.trackingSince)}.`;
        note.hidden = false;
    } else {
        note.hidden = true;
    }
};

// ---- Page --------------------------------------------------------------------

const renderRangeSwitch = () => {
    for (const button of document.querySelectorAll(".range-btn")) {
        const active = Number(button.dataset.days) === rangeDays;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    }
};

const render = async () => {
    const range = await STATS.loadRange(rangeDays);
    renderRangeSwitch();
    renderNote(range);
    renderCards(range);
    renderScreenTime(range);
    renderShortsReels(range);
    renderTopSites(range);
    await renderHeatmap();
};

document.addEventListener("DOMContentLoaded", () => {
    for (const [id, icon] of [["#insights-link", "insights"], ["#settings-link", "gear"]]) {
        document.querySelector(`${id} .icon`).innerHTML = globalThis.ATTENTION_ICONS.markup[icon];
    }
    for (const button of document.querySelectorAll(".range-btn")) {
        button.addEventListener("click", () => {
            rangeDays = RANGES.includes(Number(button.dataset.days)) ? Number(button.dataset.days) : DEFAULT_RANGE;
            render();
        });
    }
    render();
});

// Live updates: the worker writes statistics as they happen. Coalesce bursts
// (a sweep plus a screen time credit) into one re-render per tick.
let renderQueued = false;
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some(STATS.isStatsKey) || renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
        renderQueued = false;
        render();
    }, 200);
});
