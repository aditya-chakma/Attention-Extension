/**
 * Central registry of the SVG icons the extension draws into YouTube's player.
 * To change or add an icon, edit ICON_PATHS below; nothing else needs to change.
 *
 * Each entry is the `d` attribute of a 24x24 Material icon. Loaded as a content
 * script before contentScript.js (see manifest.json), which reads
 * globalThis.ATTENTION_ICONS.
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

    /**
     * Builds a white player icon. The 24x24 icon sits in a 36x36 viewBox
     * (6 units of padding on each side), the same geometry as YouTube's own
     * player icons, so it scales like them and the drop shadow is not clipped.
     * Built with createElementNS because YouTube enforces Trusted Types, which
     * rejects innerHTML string assignments.
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

    globalThis.ATTENTION_ICONS = Object.freeze({ paths: ICON_PATHS, createIcon, setIcon });
})();
