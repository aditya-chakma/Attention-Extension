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
    let intervalId = null;
    let currentVideoBookmarks = [];

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

        // Clear existing interval to avoid duplicate timer loops (memory leak)
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }

        if (source === "fb") {
            removeReels();
            intervalId = setInterval(removeReels, 2000);
        } else if (source === "yt-home" || source === "yt-watch") {
            if (source === "yt-watch") {
                isAsync = bookMark(obj, response);
            }

            removeShorts(source);
            intervalId = setInterval(() => removeShorts(source), 2000);
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

    function removeShorts(source) {
        const shorts =
            source === "yt-home"
                ? document.querySelectorAll("ytd-rich-section-renderer")
                : document.querySelectorAll("ytd-reel-shelf-renderer");

        if (shorts && shorts.length > 0) {
            shorts.forEach((el) => el.remove());

            console.log("Attention extension has removed " + shorts.length + " shorts from " + source);
        }
    }

    function removeReels() {
        const reels = document.querySelectorAll('[aria-label="Reels"]');

        if (reels && reels.length > 0) {
            reels.forEach((el) => el.remove());

            console.log("Attention extension has removed " + reels.length + " reels");
        }
    }
})();

const getTime = (t) => {
    var date = new Date(0);
    date.setSeconds(t);

    return date.toISOString().slice(11, 19);
};
