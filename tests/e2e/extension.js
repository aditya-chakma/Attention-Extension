import { test as base, chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The extension is the repository root (manifest.json lives there)
const extensionPath = path.resolve(here, "../..");
const fixturesDir = path.join(here, "fixtures");
const ONE_PIXEL_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const workerOf = async (context) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    return worker;
};

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
        // Dashboard thumbnails: serve a 1x1 PNG instead of hitting i.ytimg.com
        await context.route("https://i.ytimg.com/**", (route) =>
            route.fulfill({ contentType: "image/png", body: Buffer.from(ONE_PIXEL_PNG, "base64") })
        );

        // On install the background worker seeds the default blocked sites and
        // installs their blocking rules asynchronously; wait for that so the
        // first navigation of a test is already subject to them
        const worker = await workerOf(context);
        await expect
            .poll(() => worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length)))
            .toBeGreaterThan(0);

        await use(context);
        await context.close();
    },

    serviceWorker: async ({ context }, use) => {
        await use(await workerOf(context));
    },

    extensionId: async ({ serviceWorker }, use) => {
        await use(new URL(serviceWorker.url()).host);
    },
});

export { expect };
