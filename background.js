// chrome.tabs.onUpdated.addListener((tabId, tab) => {
//   console.log("Hello background.js");

//   if (tab.url && tab.url.includes("youtube.com")) {
//     const queryParameters = tab.url.split("?")[1];
//     const urlParameters = new URLSearchParams(queryParameters);

//     console.log("URL params: " + urlParameters);

//     chrome.tabs.sendMessage(tabId, {
//       type: "NEW",
//       videoId: urlParameters.get("v"),
//     });
//   }
// });
