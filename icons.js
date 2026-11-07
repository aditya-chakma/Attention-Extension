/**
 * Central registry of every SVG icon the extension draws. To change or add an
 * icon, edit this file; nothing else needs to change.
 *
 * Loaded two ways, which is why it is a plain script publishing a global
 * instead of an ES module:
 *  - as a content script before contentScript.js (see manifest.json)
 *  - via `import "./icons.js"` from the extension pages (dashboard.js, popup.js)
 *
 * Two kinds of entries:
 *  - ICON_PATHS: 24x24 Material icon path data for the YouTube player buttons,
 *    built element-by-element because YouTube enforces Trusted Types, which
 *    rejects innerHTML string assignments.
 *  - ICON_MARKUP: complete <svg> strings for the extension's own pages (popup,
 *    dashboard), where static innerHTML is safe and simpler.
 */
(() => {
    const SVG_NS = "http://www.w3.org/2000/svg";

    const ICON_PATHS = Object.freeze({
        // "more_time": clock with a plus, for the timestamp bookmark button
        timestampBookmark:
            "M10 8v6l4.7 2.9.8-1.2-4-2.4V8z" +
            "M17.92 12c.05.33.08.66.08 1 0 3.9-3.1 7-7 7s-7-3.1-7-7 3.1-7 7-7c.7 0 1.37.1 2 .29V4.23" +
            "c-.64-.15-1.31-.23-2-.23-5 0-9 4-9 9s4 9 9 9 9-4 9-9c0-.34-.02-.67-.06-1h-2.02z" +
            "M20 5V2h-2v3h-3v2h3v3h2V7h3V5z",
        // "bookmark_border": video not bookmarked yet
        videoBookmark: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z",
        // "bookmark": solid, shown once the current video is bookmarked
        videoBookmarked: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z",
    });

    const ICON_MARKUP = Object.freeze({
        // Trash can: delete buttons on the dashboard cards
        trash:
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>',
        // Play triangle: "open at timestamp" links on the dashboard
        play:
            '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">' +
            '<path d="M8 5v14l11-7z" /></svg>',
        // Four-square grid: the popup's "open dashboard" button
        dashboardGrid:
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />' +
            '<rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>',
    });

    /**
     * Builds a white player icon. The 24x24 icon sits in a 36x36 viewBox
     * (6 units of padding on each side), the same geometry as YouTube's own
     * player icons, so it scales like them and the drop shadow is not clipped.
     */
    const createIcon = (name) => {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "-6 -6 36 36");
        svg.setAttribute("height", "100%");
        svg.setAttribute("width", "100%");
        svg.setAttribute("aria-hidden", "true");

        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("class", "ytp-svg-fill");
        path.setAttribute("fill", "#fff");
        svg.appendChild(path);

        setIcon(svg, name);
        return svg;
    };

    /** Swaps the icon drawn by an svg created with createIcon. */
    const setIcon = (svg, name) => {
        if (!(name in ICON_PATHS)) throw new Error(`Unknown icon: ${name}`);
        svg.dataset.icon = name;
        svg.querySelector("path").setAttribute("d", ICON_PATHS[name]);
    };

    globalThis.ATTENTION_ICONS = Object.freeze({
        paths: ICON_PATHS,
        markup: ICON_MARKUP,
        createIcon,
        setIcon,
    });
})();
