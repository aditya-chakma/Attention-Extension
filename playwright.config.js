import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "tests/e2e",
    testMatch: "**/*.spec.js",
    // Each test launches its own Chromium with the extension loaded; keep it sequential for stability
    workers: 1,
    fullyParallel: false,
    timeout: 30_000,
    expect: { timeout: 5_000 },
    reporter: process.env.CI ? "github" : "list",
    use: {
        trace: "retain-on-failure",
    },
});
