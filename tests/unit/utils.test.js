import { describe, it, expect } from "vitest";
import { getActiveTabURL } from "../../utils.js";

describe("getActiveTabURL", () => {
    it("queries the active tab of the current window and returns it", async () => {
        const tab = { id: 42, url: "https://www.youtube.com/watch?v=x" };
        chrome.tabs.query.mockResolvedValue([tab]);

        const result = await getActiveTabURL();

        expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
        expect(result).toBe(tab);
    });

    it("returns undefined when no tab matches", async () => {
        chrome.tabs.query.mockResolvedValue([]);

        expect(await getActiveTabURL()).toBeUndefined();
    });
});
