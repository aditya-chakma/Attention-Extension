chrome.tabs.onUpdated.addListener((tabId, tab) => {
  if (tab.url && tab.url.includes("youtube")) {
    chrome.tabs.sendMessage(tabId, {
      source: "yt",
    });
  }

  if (tab.url && tab.url.includes("facebook")) {
    chrome.tabs.sendMessage(tabId, {
      type: "NEW",
      source: "fb",
    });
  }
});
