/**
 * The small chart toolkit behind insights.html. No library: the extension
 * ships no build step and MV3 pages can't load remote scripts, and these five
 * shapes are all the Insights page needs.
 *
 * Every function returns a detached DOM element for the caller to append.
 * Dynamic values only ever go through textContent and attributes, never
 * innerHTML. Charts draw into a fixed viewBox and scale with the page; each
 * bar, point and cell carries a <title> (or title attribute) tooltip.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const svgEl = (tag, attributes = {}) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
};

const tooltip = (node, text) => {
    const title = svgEl("title");
    title.textContent = text;
    node.appendChild(title);
};

// Plot geometry shared by the bar and line charts
const PLOT_W = 100;
const PLOT_H = 36;

const plotSvg = (label) => {
    const svg = svgEl("svg", {
        viewBox: `0 0 ${PLOT_W} ${PLOT_H}`,
        preserveAspectRatio: "none",
        class: "chart-plot",
        role: "img",
    });
    if (label) svg.setAttribute("aria-label", label);
    return svg;
};

/** First / middle / last x-axis labels under a daily chart. */
const xAxis = (labels) => {
    const row = el("div", "chart-x-axis");
    const picks = labels.length <= 2 ? labels : [labels[0], labels[Math.floor(labels.length / 2)], labels[labels.length - 1]];
    for (const text of picks) row.appendChild(el("span", null, text));
    return row;
};

const yMaxLabel = (text) => el("div", "chart-y-max", text);

/**
 * Headline number card. trend (optional): { text, direction: "up"|"down",
 * good: true|false|null } — e.g. "12% less than the 30 days before".
 */
export const statCard = ({ label, value, sub, trend }) => {
    const card = el("div", "stat-card");
    card.appendChild(el("div", "stat-label", label));
    card.appendChild(el("div", "stat-value", value));
    if (sub) card.appendChild(el("div", "stat-sub", sub));
    if (trend) {
        const tone = trend.good === null ? "neutral" : trend.good ? "good" : "bad";
        const arrow = el("span", "stat-trend-arrow", trend.direction === "up" ? "▲" : "▼");
        arrow.setAttribute("aria-hidden", "true");
        const line = el("div", `stat-trend ${tone}`);
        line.append(arrow, " ", trend.text);
        card.appendChild(line);
    }
    return card;
};

/**
 * Daily stacked bars. days: [{ label, tooltip, parts: [{ key, value }] }];
 * the key picks the bar segment's CSS class (chart-part-<key>).
 */
export const stackedBarChart = ({ days, formatValue = String, ariaLabel }) => {
    const wrap = el("div", "chart");
    const max = Math.max(1, ...days.map((d) => d.parts.reduce((t, p) => t + p.value, 0)));
    const svg = plotSvg(ariaLabel);

    const slot = PLOT_W / days.length;
    const barWidth = Math.min(slot * 0.7, 6);
    days.forEach((day, i) => {
        const total = day.parts.reduce((t, p) => t + p.value, 0);
        const x = slot * i + (slot - barWidth) / 2;
        let y = PLOT_H;
        const group = svgEl("g");
        for (const part of day.parts) {
            if (part.value <= 0) continue;
            const height = (part.value / max) * (PLOT_H - 2);
            y -= height;
            group.appendChild(
                svgEl("rect", { x, y, width: barWidth, height, class: `chart-part-${part.key}`, rx: 0.8 })
            );
        }
        if (total === 0) {
            // A faint stub, so days with nothing still mark their place
            group.appendChild(svgEl("rect", { x, y: PLOT_H - 0.5, width: barWidth, height: 0.5, class: "chart-part-empty" }));
        }
        tooltip(group, `${day.tooltip ?? day.label}: ${day.parts.map((p) => `${formatValue(p.value)} ${p.key}`).join(", ")}`);
        svg.appendChild(group);
    });

    wrap.append(yMaxLabel(formatValue(max)), svg, xAxis(days.map((d) => d.label)));
    return wrap;
};

/** Daily area/line chart. points: [{ label, tooltip, value }]. */
export const lineChart = ({ points, formatValue = String, ariaLabel }) => {
    const wrap = el("div", "chart");
    const max = Math.max(1, ...points.map((p) => p.value));
    const svg = plotSvg(ariaLabel);

    const step = points.length > 1 ? PLOT_W / (points.length - 1) : 0;
    const x = (i) => (points.length > 1 ? i * step : PLOT_W / 2);
    const y = (value) => PLOT_H - 1 - (value / max) * (PLOT_H - 3);
    const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");

    svg.appendChild(
        svgEl("polygon", {
            points: `0,${PLOT_H} ${line} ${PLOT_W},${PLOT_H}`,
            class: "chart-area",
        })
    );
    svg.appendChild(svgEl("polyline", { points: line, class: "chart-line", "vector-effect": "non-scaling-stroke" }));
    points.forEach((p, i) => {
        // An invisible hover strip per day, wider than the dot, for the tooltip
        const hover = svgEl("rect", { x: x(i) - step / 2, y: 0, width: Math.max(step, 2), height: PLOT_H, class: "chart-hover" });
        tooltip(hover, `${p.tooltip ?? p.label}: ${formatValue(p.value)}`);
        svg.appendChild(hover);
    });

    wrap.append(yMaxLabel(formatValue(max)), svg, xAxis(points.map((p) => p.label)));
    return wrap;
};

/** Top-N horizontal ranking. entries: [{ label, value, sub }]. */
export const rankedBars = ({ entries, formatValue = String, emptyText = "Nothing yet" }) => {
    const list = el("div", "ranked-bars");
    if (entries.length === 0) {
        list.appendChild(el("div", "chart-empty", emptyText));
        return list;
    }
    const max = Math.max(1, ...entries.map((e) => e.value));
    for (const entry of entries) {
        const row = el("div", "ranked-row");
        const name = el("div", "ranked-label", entry.label);
        name.title = entry.label;
        const track = el("div", "ranked-track");
        const fill = el("div", "ranked-fill");
        fill.style.width = `${Math.max(2, (entry.value / max) * 100)}%`;
        track.appendChild(fill);
        const value = el("div", "ranked-value", formatValue(entry.value));
        if (entry.sub) value.appendChild(el("span", "ranked-sub", entry.sub));
        row.append(name, track, value);
        list.appendChild(row);
    }
    return list;
};

/**
 * Calendar heatmap, one cell per day in GitHub's layout: columns are weeks,
 * rows Sunday..Saturday, oldest week left. days: [{ day, label, value }]
 * oldest first; level is value/max in 5 steps.
 */
export const calendarHeatmap = ({ days, formatValue = String }) => {
    const wrap = el("div", "heatmap");
    const max = Math.max(1, ...days.map((d) => d.value));
    const grid = el("div", "heatmap-grid");

    // Pad the first week so weekdays line up; day keys are "YYYY-MM-DD" local
    const dayOfWeek = (key) => {
        const [year, month, dayOfMonth] = key.split("-").map(Number);
        return new Date(year, month - 1, dayOfMonth).getDay();
    };
    if (days.length > 0) {
        for (let i = 0; i < dayOfWeek(days[0].day); i++) grid.appendChild(el("span", "heatmap-cell pad"));
    }
    for (const day of days) {
        const level = day.value <= 0 ? 0 : Math.min(4, 1 + Math.floor((day.value / max) * 3.999));
        const cell = el("span", `heatmap-cell level-${level}`);
        cell.title = `${day.label}: ${formatValue(day.value)}`;
        grid.appendChild(cell);
    }

    const weeks = Math.ceil((grid.children.length || 1) / 7);
    grid.style.gridTemplateRows = "repeat(7, var(--heatmap-cell))";
    grid.style.gridTemplateColumns = `repeat(${weeks}, var(--heatmap-cell))`;
    wrap.appendChild(grid);
    return wrap;
};
