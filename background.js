chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // onUpdated fires several times per navigation (loading, title, favicon...);
    // only act on URL changes (SPA navigation) and the final load
    if (!changeInfo.url && changeInfo.status !== "complete") {
        return;
    }

    var properties = {};
    var allowedUrls = ["youtube.com", "facebook.com"];
    var tabUrl = "none";

    if (tab.url && tab.url.includes("youtube.com")) {
        tabUrl = "youtube.com";
        properties["url"] = tab.url;

        if (tab.url.includes("watch")) {
            properties["source"] = "yt-watch";
            properties["type"] = "NEW";

            const queryParameters = tab.url.split("?")[1];
            const urlParameters = new URLSearchParams(queryParameters);
            properties["videoId"] = urlParameters.get("v");
        } else {
            properties["source"] = "yt-home";
        }
    }

    if (tab.url && tab.url.includes("facebook.com")) {
        tabUrl = "facebook.com";
        properties["source"] = "fb";
        properties["url"] = tab.url;
    }

    if (allowedUrls.includes(tabUrl)) {
        // The content script may not be injected yet on first load; ignore that
        chrome.tabs.sendMessage(tabId, properties).catch(() => {});
    }
});
