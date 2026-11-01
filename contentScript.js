(() => {
    const blockedUrls = ["facebook.com"];
    let currentUrl = window.location.toString();

    blockedUrls.forEach((blockedUrl) => {
        console.log("Blocked url: " + blockedUrl);
        if (currentUrl.length > 0 && currentUrl.includes(blockedUrl)) {
            window.location.href = chrome.runtime.getURL("blocked.html");
        }
    });

    let youtubeLeftControls, youtubePlayer;
    let currentVideo = "";
    let currentVideoBookmarks = [];

    // hide.css pre-hides these selectors instantly; the observer below then
    // deletes the matching nodes from the DOM, scoped to the current page type
    const REMOVAL_SELECTORS = {
        "fb": '[aria-label="Reels"]',
        "yt-home": "ytd-rich-section-renderer",
        "yt-watch": "ytd-reel-shelf-renderer",
    };

    let activeSource = null;
    let sweepScheduled = false;
    let domObserver = null;

    function sweep() {
        sweepScheduled = false;
        if (!activeSource) return;

        const nodes = document.querySelectorAll(REMOVAL_SELECTORS[activeSource]);
        if (nodes.length > 0) {
            nodes.forEach((el) => el.remove());

            if (activeSource === "fb") {
                console.log("Attention extension has removed " + nodes.length + " reels");
            } else {
                console.log("Attention extension has removed " + nodes.length + " shorts from " + activeSource);
            }
        }
    }

    function scheduleSweep() {
        if (sweepScheduled) return;
        sweepScheduled = true;
        // Coalesce mutation bursts into one pass per frame; rAF pauses in hidden tabs
        requestAnimationFrame(sweep);
    }

    function startRemoval(source) {
        activeSource = source;
        sweep();

        if (!domObserver) {
            domObserver = new MutationObserver(scheduleSweep);
            domObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    const waitForElement = (className, timeout = 10000) => {
        return new Promise((resolve) => {
            const element = document.getElementsByClassName(className)[0];
            if (element) {
                return resolve(element);
            }

            const observer = new MutationObserver(() => {
                const el = document.getElementsByClassName(className)[0];
                if (el) {
                    resolve(el);
                    observer.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    };

    chrome.runtime.onMessage.addListener((obj, sender, response) => {
        const { type, source } = obj;
        let isAsync = false;

        if (source === "fb") {
            startRemoval("fb");
        } else if (source === "yt-home" || source === "yt-watch") {
            if (source === "yt-watch") {
                isAsync = bookMark(obj, response);
            }

            startRemoval(source);
        }

        return isAsync;
    });

    function bookMark(obj, response) {
        const { type, source, value, videoId } = obj;

        if (source !== "yt-watch") {
            return false;
        }

        if (type === "NEW") {
            currentVideo = videoId;
            newVideoLoaded();
            return false;
        } else if (type === "PLAY") {
            if (youtubePlayer) {
                youtubePlayer.currentTime = value;
            }
            return false;
        } else if (type === "DELETE") {
            currentVideoBookmarks = currentVideoBookmarks.filter((b) => b.time != value);
            chrome.storage.sync.set({ [currentVideo]: JSON.stringify(currentVideoBookmarks) }, () => {
                response(currentVideoBookmarks);
            });
            return true;
        }
        return false;
    }

    const fetchBookmarks = () => {
        return new Promise((resolve) => {
            chrome.storage.sync.get([currentVideo], (obj) => {
                resolve(obj[currentVideo] ? JSON.parse(obj[currentVideo]) : []);
            });
        });
    };

    const newVideoLoaded = async () => {
        currentVideoBookmarks = await fetchBookmarks();

        // Always update references to ensure we point to the active player element on SPA transitions
        youtubeLeftControls = await waitForElement("ytp-left-controls");
        youtubePlayer = await waitForElement("video-stream");

        const bookmarkBtnExist = document.getElementsByClassName("bookmark-btn")[0];

        if (youtubeLeftControls && youtubePlayer && !bookmarkBtnExist) {
            const bookmarkBtn = document.createElement("img");

            bookmarkBtn.src = chrome.runtime.getURL("assets/bookmark.png");
            bookmarkBtn.className = "ytp-button " + "bookmark-btn";
            bookmarkBtn.title = "Click to bookmark current timestamp";

            youtubeLeftControls.appendChild(bookmarkBtn);
            bookmarkBtn.addEventListener("click", addNewBookmarkEventHandler);
        }
    };

    const addNewBookmarkEventHandler = async () => {
        if (!youtubePlayer) return;
        const currentTime = youtubePlayer.currentTime;
        const newBookmark = {
            time: currentTime,
            desc: "Bookmark at " + getTime(currentTime),
        };

        currentVideoBookmarks = await fetchBookmarks();

        chrome.storage.sync.set({
            [currentVideo]: JSON.stringify([...currentVideoBookmarks, newBookmark].sort((a, b) => a.time - b.time)),
        });
    };

    // YouTube is an SPA: react to its own navigation event instead of waiting for
    // a background message (which can race with content script injection on load)
    const onYouTubeNavigation = () => {
        const source = window.location.href.includes("watch") ? "yt-watch" : "yt-home";
        startRemoval(source);

        if (source === "yt-watch") {
            const videoId = new URLSearchParams(window.location.search).get("v");
            if (videoId) {
                currentVideo = videoId;
                newVideoLoaded();
            }
        }
    };

    if (window.location.hostname.includes("youtube.com")) {
        onYouTubeNavigation();
        document.addEventListener("yt-navigate-finish", onYouTubeNavigation);
    }
})();

const getTime = (t) => {
    var date = new Date(0);
    date.setSeconds(t);

    return date.toISOString().slice(11, 19);
};
