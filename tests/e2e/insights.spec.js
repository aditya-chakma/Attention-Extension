import { test, expect } from "./extension.js";

// Seeds statistics through the real statsStore in the worker
const record = (serviceWorker, event, daysAgo = 0) =>
    serviceWorker.evaluate(
        ([e, offset]) => {
            const when = new Date();
            when.setDate(when.getDate() - offset);
            return globalThis.ATTENTION_STATS.record(e, when);
        },
        [event, daysAgo]
    );

const cardValue = (page, label) =>
    page.locator(".stat-card", { hasText: label }).locator(".stat-value").textContent();

test.describe("Insights page", () => {
    test("shows the recorded numbers in cards and charts", async ({ page, serviceWorker, extensionId }) => {
        await record(serviceWorker, { event: "removal", kind: "shorts", count: 12 });
        await record(serviceWorker, { event: "removal", kind: "reels", count: 3 });
        await record(serviceWorker, { event: "redirect", kind: "shorts" });
        await record(serviceWorker, { event: "blockedVisit", domain: "reddit.com" });
        await record(serviceWorker, { event: "blockedVisit", domain: "reddit.com" });
        await record(serviceWorker, { event: "unblock", domain: "reddit.com", minutes: 15 });
        await record(serviceWorker, { event: "screenTime", domain: "youtube.com", ms: 32 * 60000 });

        await page.goto(`chrome-extension://${extensionId}/insights.html`);

        await expect(page.locator("header #insights-link")).toHaveAttribute("aria-current", "page");
        expect(await cardValue(page, "Screen time")).toBe("32m");
        expect(await cardValue(page, "Blocked visits")).toBe("2");
        expect(await cardValue(page, "Shorts & Reels blocked")).toBe("16");
        expect(await cardValue(page, "Temporary unblocks")).toBe("1");
        expect(await cardValue(page, "Focus streak")).toBe("0 days");
        // 2x10m visits + 1x5m redirect + 15x1m removals = 40m
        expect(await cardValue(page, "Time saved (estimate)")).toBe("40m");

        await expect(page.locator("#top-sites-chart .ranked-row")).toHaveCount(1);
        await expect(page.locator("#top-sites-chart .ranked-label").first()).toHaveText("reddit.com");
        await expect(page.locator("#screen-time-chart .chart-hover")).toHaveCount(7);
        await expect(page.locator("#heatmap-chart .heatmap-cell:not(.pad)")).toHaveCount(91);
    });

    test("the range switch includes older days", async ({ page, serviceWorker, extensionId }) => {
        await record(serviceWorker, { event: "blockedVisit", domain: "x.com" }, 20); // 20 days ago

        await page.goto(`chrome-extension://${extensionId}/insights.html`);
        await expect(page.locator(".stat-card", { hasText: "Blocked visits" }).locator(".stat-value")).toHaveText("0");

        await page.locator('.range-btn[data-days="30"]').click();

        await expect(page.locator(".stat-card", { hasText: "Blocked visits" }).locator(".stat-value")).toHaveText("1");
        await expect(page.locator("#screen-time-chart .chart-hover")).toHaveCount(30);
    });

    test("updates live while open, as the worker records new events", async ({ page, serviceWorker, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/insights.html`);
        await expect(page.locator(".stat-card", { hasText: "Blocked visits" }).locator(".stat-value")).toHaveText("0");

        await record(serviceWorker, { event: "blockedVisit", domain: "reddit.com" });

        await expect(page.locator(".stat-card", { hasText: "Blocked visits" }).locator(".stat-value")).toHaveText("1");
    });

    test("is reachable from the Settings header and links back", async ({ page, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/settings.html`);
        await page.locator("header #insights-link").click();

        await expect(page).toHaveURL(`chrome-extension://${extensionId}/insights.html`);
        await expect(page.locator("header #insights-link svg")).toBeVisible();

        await page.locator("header #settings-link").click();
        await expect(page).toHaveURL(`chrome-extension://${extensionId}/settings.html`);
    });

    test("Clear statistics on the Settings page empties the Insights page", async ({ page, serviceWorker, extensionId }) => {
        await record(serviceWorker, { event: "blockedVisit", domain: "reddit.com" });
        await page.goto(`chrome-extension://${extensionId}/settings.html`);

        page.on("dialog", (dialog) => dialog.accept());
        await page.locator("#clear-stats").click();
        await expect(page.locator("#stats-notice")).toHaveText("Statistics cleared");

        await page.goto(`chrome-extension://${extensionId}/insights.html`);
        await expect(page.locator(".stat-card", { hasText: "Blocked visits" }).locator(".stat-value")).toHaveText("0");
        await expect(page.locator("#insights-note")).toContainText("Nothing measured yet");
    });
});
