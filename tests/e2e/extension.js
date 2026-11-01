import { test as base, chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The extension is the repository root (manifest.json lives there)
const extensionPath = path.resolve(here, "../..");
const fixturesDir = path.join(here, "fixtures");

/**
 * Playwright fixtures that launch Chromium with the unpacked extension loaded.
 *
 * Real youtube.com / facebook.com are never contacted: requests to those hosts
 * are fulfilled with the static HTML files in ./fixtures. Because the page URL
 * still matches the manifest's host patterns, Chromium injects the real
 * content script, hide.css and runs the real background service worker.
 */
export const test = base.extend({
    context: async ({}, use) => {
        const context = await chromium.launchPersistentContext("", {
            channel: "chromium", // new headless mode, which supports extensions
            args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        });

        await context.route("https://www.youtube.com/**", (route) => {
            const url = new URL(route.request().url());
            const file = url.pathname.startsWith("/watch") ? "youtube-watch.html" : "youtube-home.html";
            return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(fixturesDir, file), "utf8") });
        });
        await context.route("https://www.facebook.com/**", (route) =>
            route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(fixturesDir, "facebook.html"), "utf8") })
        );

        await use(context);
        await context.close();
    },

    serviceWorker: async ({ context }, use) => {
        let [worker] = context.serviceWorkers();
        if (!worker) worker = await context.waitForEvent("serviceworker");
        await use(worker);
    },

    extensionId: async ({ serviceWorker }, use) => {
        await use(new URL(serviceWorker.url()).host);
    },
});

export { expect };
