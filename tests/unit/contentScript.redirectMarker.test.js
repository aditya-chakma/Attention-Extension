/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.youtube.com/?app=desktop#attention-redirect=shorts" }
 */
import { it, expect, beforeAll, vi } from "vitest";
import { flushPromises } from "./helpers.js";

// The page a background.js redirect rule sent a Shorts URL to
let atLoad;

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await import("../../icons.js");
    await import("../../bookmarkStore.js");
    await import("../../settingsStore.js");
    await import("../../contentScript.js");
    await flushPromises();

    atLoad = {
        href: window.location.href,
        redirectReports: chrome.runtime.sendMessage.mock.calls
            .map(([message]) => message)
            .filter((m) => m.type === "STATS_EVENT" && m.event.event === "redirect"),
    };
});

it("counts the redirect that brought the user here, once", () => {
    expect(atLoad.redirectReports).toEqual([{ type: "STATS_EVENT", event: { event: "redirect", kind: "shorts" } }]);
});

it("removes the marker from the address bar, keeping the rest of the URL", () => {
    expect(atLoad.href).toBe("https://www.youtube.com/?app=desktop");
});
