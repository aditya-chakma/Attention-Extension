import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/package.sh lists the files shipped to the Chrome Web Store by hand.
// A file missing from that list still works unpacked but breaks the
// published extension, so these tests derive what the extension loads and
// check it against the list.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

const packaged = (() => {
    const block = read("scripts/package.sh").match(/FILES=\(([\s\S]*?)\)/)[1];
    return block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
})();

/** True when the file is listed, directly or under a listed directory. */
const isPackaged = (file) => packaged.some((entry) => file === entry || file.startsWith(entry + "/"));

// Every page at the top level is part of the extension (popup, dashboard,
// settings, insights, blocked); configs and tests live elsewhere
const pages = fs.readdirSync(root).filter((f) => f.endsWith(".html"));

const localRef = (ref) => ref && !/^(https?:|chrome|data:|#|mailto:)/.test(ref);
const normalize = (ref) => ref.replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0];

/** Files a page loads directly: scripts, stylesheets and images. */
const pageAssets = (page) => {
    const html = read(page);
    const refs = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    return refs.filter(localRef).map(normalize);
};

/** A script plus everything it imports, recursively ("./x.js" imports only). */
const withImports = (file, seen = new Set()) => {
    if (seen.has(file) || !file.endsWith(".js")) return seen;
    seen.add(file);
    const source = read(file);
    for (const m of source.matchAll(/^\s*import\s+(?:[^"']*?\s+from\s+)?["'](\.\/[^"']+)["']/gm)) {
        withImports(normalize(m[1]), seen);
    }
    return seen;
};

const manifestFiles = () => [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
    ...manifest.web_accessible_resources.flatMap((r) => r.resources),
];

const required = () => {
    const files = new Set([...manifestFiles(), ...pages]);
    for (const page of pages) for (const asset of pageAssets(page)) files.add(asset);
    for (const file of [...files]) for (const imported of withImports(file)) files.add(imported);
    return [...files].sort();
};

describe("scripts/package.sh", () => {
    it("lists only files that exist", () => {
        for (const entry of packaged) {
            expect(fs.existsSync(path.join(root, entry)), `${entry} should exist`).toBe(true);
        }
    });

    it("ships every file the manifest, the pages and their imports load", () => {
        const missing = required().filter((file) => !isPackaged(file));
        expect(missing, "add these to FILES in scripts/package.sh").toEqual([]);
    });

    it("finds the files these checks rely on (the parsing isn't silently empty)", () => {
        const files = required();
        // One from each source: manifest, page <script>, page <link>, a JS import
        expect(files).toContain("background.js");
        expect(files).toContain("insights.js");
        expect(files).toContain("insights.css");
        expect(files).toContain("charts.js");
        expect(files).toContain("screenTime.js");
        expect(files).toContain("statsStore.js");
        expect(files).toContain("utils.js");
    });

    it("ships no tests, configs or dev tooling", () => {
        for (const entry of packaged) {
            expect(entry).not.toMatch(/^(tests|node_modules|scripts|dist|test-results)(\/|$)/);
            expect(entry).not.toMatch(/(^|\/)(package(-lock)?\.json|vitest\.config\.js|playwright\.config\.js)$/);
        }
    });

    it("leaves out no top-level source file", () => {
        const configs = new Set(["vitest.config.js", "playwright.config.js"]);
        const sources = fs
            .readdirSync(root)
            .filter((f) => /\.(js|css|html)$/.test(f) && !configs.has(f));
        expect(sources.filter((file) => !isPackaged(file))).toEqual([]);
    });
});
