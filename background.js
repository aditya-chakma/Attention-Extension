chrome.tabs.onUpdated.addListener((tabId, _, tab) => {
    var properties = {};
    var allowedUrls = ["youtube.com", "facebook.com"];
    var tabUrl = "none";

    if (tab.url && tab.url.includes("youtube.com")) {
        tabUrl = "youtube.com";
        properties["url"] = tab.url;
        if (tab.url.includes("watch")) {
            properties["source"] = "yt-watch";
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
        chrome.tabs.sendMessage(tabId, properties);
    }
});
