import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

describe("manifest.json", () => {
    it("is Manifest V3 with the expected permissions", () => {
        expect(manifest.manifest_version).toBe(3);
        expect(manifest.permissions).toEqual(expect.arrayContaining(["storage", "tabs", "alarms", "declarativeNetRequest"]));
    });

    it("can redirect any site the user blocks", () => {
        // Redirect rules need host access to the sites they redirect
        expect(manifest.host_permissions).toContain("<all_urls>");
    });

    it("runs the background worker as a module so it can import the stores", () => {
        expect(manifest.background.type).toBe("module");
    });

    it("references files that exist", () => {
        const referenced = [
            manifest.background.service_worker,
            manifest.action.default_popup,
            ...Object.values(manifest.action.default_icon),
            ...manifest.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
            ...manifest.web_accessible_resources.flatMap((r) => r.resources),
        ];

        for (const file of referenced) {
            expect(fs.existsSync(path.join(root, file)), `${file} should exist`).toBe(true);
        }
    });

    it("injects the pre-hide stylesheet alongside the content script", () => {
        const [contentScript] = manifest.content_scripts;
        expect(contentScript.js).toContain("contentScript.js");
        expect(contentScript.css).toContain("hide.css");
    });

    it("loads the icon registry before the content script, along with the player button styles", () => {
        const [contentScript] = manifest.content_scripts;
        expect(contentScript.js.indexOf("icons.js")).toBeGreaterThanOrEqual(0);
        expect(contentScript.js.indexOf("icons.js")).toBeLessThan(contentScript.js.indexOf("contentScript.js"));
        expect(contentScript.css).toContain("player-buttons.css");
    });

    it("loads the settings store before the content script and runs at document_start", () => {
        const [contentScript] = manifest.content_scripts;
        expect(contentScript.js.indexOf("settingsStore.js")).toBeGreaterThanOrEqual(0);
        expect(contentScript.js.indexOf("settingsStore.js")).toBeLessThan(contentScript.js.indexOf("contentScript.js"));
        // Early enough to read the toggles before the page renders
        expect(contentScript.run_at).toBe("document_start");
    });

    it("hide.css hides by default and only shows when the content script sets the attribute", () => {
        const css = read("hide.css");
        expect(css).toContain("html:not([data-attention-show-shorts]) ytd-rich-section-renderer");
        expect(css).toContain("html:not([data-attention-show-shorts]) ytd-reel-shelf-renderer");
        expect(css).toContain('html:not([data-attention-show-reels]) [aria-label="Reels"]');
    });

    it("loads the bookmark store before the content script", () => {
        const [contentScript] = manifest.content_scripts;
        expect(contentScript.js.indexOf("bookmarkStore.js")).toBeGreaterThanOrEqual(0);
        expect(contentScript.js.indexOf("bookmarkStore.js")).toBeLessThan(contentScript.js.indexOf("contentScript.js"));
    });

    it("exposes blocked.html to every site, as any of them can be blocked", () => {
        const entry = manifest.web_accessible_resources.find((r) => r.resources.includes("blocked.html"));
        expect(entry.matches).toContain("<all_urls>");
    });
});

describe("hide.css", () => {
    it("pre-hides every selector the content script removes", () => {
        const css = read("hide.css");
        const script = read("contentScript.js");

        // Pull the selector values out of REMOVAL_SELECTORS in contentScript.js
        const block = script.match(/REMOVAL_SELECTORS\s*=\s*\{([\s\S]*?)\};/)[1];
        const selectors = [...block.matchAll(/:\s*(['"])(.*?)\1\s*,/g)].map((m) => m[2]);

        expect(selectors.length).toBeGreaterThanOrEqual(3);
        for (const selector of selectors) {
            expect(css, `hide.css should hide ${selector}`).toContain(selector);
        }
        expect(css).toMatch(/display:\s*none\s*!important/);
    });
});
