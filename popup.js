import { getActiveTabURL } from "./utils.js";
// Publishes the globalThis.ATTENTION_ICONS registry (shared with the content script)
import "./icons.js";

const addNewBookmark = (bookmarksElement, bookmark) => {
    const bookmarkTitleElement = document.createElement("div");
    const newBookmarkElement = document.createElement("div");
    const controlsElement = document.createElement("div");

    bookmarkTitleElement.textContent = bookmark.desc;
    bookmarkTitleElement.className = "bookmark-title";

    controlsElement.className = "bookmark-controls";

    newBookmarkElement.id = "bookmark-" + bookmark.time;
    newBookmarkElement.className = "bookmark";
    newBookmarkElement.setAttribute("timestamp", bookmark.time);

    addControlButton(controlsElement, "Play", "play", onPlay);
    addControlButton(controlsElement, "Delete", "trash", onDelete);

    newBookmarkElement.appendChild(bookmarkTitleElement);
    newBookmarkElement.appendChild(controlsElement);
    bookmarksElement.appendChild(newBookmarkElement);
};

const viewBookmarks = (currentBookmarks = []) => {
    const bookmarksElement = document.getElementById("bookmarks");
    bookmarksElement.innerHTML = "";

    if (currentBookmarks.length > 0) {
        for (let i = 0; i < currentBookmarks.length; i++) {
            const bookmark = currentBookmarks[i];
            addNewBookmark(bookmarksElement, bookmark);
        }
    } else {
        bookmarksElement.innerHTML = '<i class="row">No bookmarks to show</i>';
    }
};

// The click target can be the button's <svg>/<path>, so resolve the row from the button
const bookmarkTimeOf = (e) => e.currentTarget.closest(".bookmark").getAttribute("timestamp");

const onPlay = async (e) => {
    const bookmarkTime = bookmarkTimeOf(e);
    const activeTab = await getActiveTabURL();
    if (!activeTab || !activeTab.id) return;

    chrome.tabs.sendMessage(activeTab.id, {
        source: "yt-watch",
        type: "PLAY",
        value: bookmarkTime,
    });
};

const onDelete = async (e) => {
    // Read before awaiting: currentTarget is cleared once the event finishes dispatching
    const bookmarkTime = bookmarkTimeOf(e);
    const activeTab = await getActiveTabURL();
    if (!activeTab || !activeTab.id) return;

    const bookmarkElementToDelete = document.getElementById("bookmark-" + bookmarkTime);

    bookmarkElementToDelete.parentNode.removeChild(bookmarkElementToDelete);

    chrome.tabs.sendMessage(
        activeTab.id,
        {
            source: "yt-watch",
            type: "DELETE",
            value: bookmarkTime,
        },
        viewBookmarks
    );
};

// Icon-only button; static markup from the icons.js registry, so innerHTML is safe
const addControlButton = (controlParent, label, iconName, eventListener) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-btn";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = globalThis.ATTENTION_ICONS.markup[iconName];
    button.addEventListener("click", eventListener);
    controlParent.appendChild(button);
};

document.addEventListener("DOMContentLoaded", async () => {
    const dashboardBtn = document.getElementById("open-dashboard");
    if (dashboardBtn) {
        dashboardBtn.innerHTML = globalThis.ATTENTION_ICONS.markup.dashboardGrid;
        dashboardBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("videos.html") });
        });
    }

    const activeTab = await getActiveTabURL();

    if (!activeTab || !activeTab.url) {
        const container = document.getElementsByClassName("container")[0];
        container.innerHTML = '<div class="title">Cannot access current tab information.</div>';
        return;
    }

    const queryParameters = activeTab.url.split("?")[1];
    const urlParameters = new URLSearchParams(queryParameters);

    const currentVideo = urlParameters.get("v");

    if (activeTab.url.includes("youtube.com/watch") && currentVideo) {
        chrome.storage.sync.get([currentVideo], (data) => {
            const currentVideoBookmarks = data[currentVideo] ? JSON.parse(data[currentVideo]) : [];

            viewBookmarks(currentVideoBookmarks);
        });
    } else {
        const container = document.getElementsByClassName("container")[0];
        container.innerHTML = '<div class="title">This is not a youtube WATCH video page</div>';
    }
});
