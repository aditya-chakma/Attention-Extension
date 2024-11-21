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
    let intervalId = "";
    let currentVideoBookmarks = [];

    chrome.runtime.onMessage.addListener((obj, sender, response) => {
        const { type, source } = obj;

        if (source === "fb") {
            removeReels();
            intervalId = setInterval(removeReels, 2000);
        } else if (source === "yt-home" || source === "yt-watch") {
            if (source === "yt-watch") {
                bookMark(obj, response);
            }

            removeShorts(source);
            intervalId = setInterval(() => removeShorts(source), 2000);
        }
    });

    function bookMark(obj, response) {
        const { type, source, value, videoId } = obj;

        if (source !== "yt-watch") {
            return;
        }

        if (type === "NEW") {
            currentVideo = videoId;
            newVideoLoaded();
        } else if (type === "PLAY") {
            youtubePlayer.currentTime = value;
        } else if (type === "DELETE") {
            currentVideoBookmarks = currentVideoBookmarks.filter((b) => b.time != value);
            chrome.storage.sync.set({ [currentVideo]: JSON.stringify(currentVideoBookmarks) });

            response(currentVideoBookmarks);
        }
    }

    const fetchBookmarks = () => {
        return new Promise((resolve) => {
            chrome.storage.sync.get([currentVideo], (obj) => {
                resolve(obj[currentVideo] ? JSON.parse(obj[currentVideo]) : []);
            });
        });
    };

    const newVideoLoaded = async () => {
        const bookmarkBtnExist = document.getElementsByClassName("bookmark-btn")[0];
        currentVideoBookmarks = await fetchBookmarks();

        if (!bookmarkBtnExist) {
            const bookmarkBtn = document.createElement("img");

            bookmarkBtn.src = chrome.runtime.getURL("assets/bookmark.png");
            bookmarkBtn.className = "ytp-button " + "bookmark-btn";
            bookmarkBtn.title = "Click to bookmark current timestamp";

            youtubeLeftControls = document.getElementsByClassName("ytp-left-controls")[0];
            youtubePlayer = document.getElementsByClassName("video-stream")[0];

            youtubeLeftControls.appendChild(bookmarkBtn);
            bookmarkBtn.addEventListener("click", addNewBookmarkEventHandler);
        }
    };

    // call on page reload
    //newVideoLoaded();

    const addNewBookmarkEventHandler = async () => {
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
        shorts =
            source === "yt-home"
                ? document.querySelectorAll("ytd-rich-section-renderer")
                : document.querySelectorAll("ytd-reel-shelf-renderer");

        if (shorts && shorts.length > 0) {
            shorts.forEach((el) => el.remove());

            console.log("Attention extension has removed " + shorts.length + " shorts from " + source);
        }
    }

    function removeReels() {
        reels = document.querySelectorAll('[aria-label="Reels"]');

        if (reels && reels.length > 0) {
            reels.forEach((el) => el.remove());

            console.log("Attention extension has removed " + reels.length + " reels");
        }
    }
})();

const getTime = (t) => {
    var date = new Date(0);
    date.setSeconds(t);

    return date.toISOString().substr(11, 8);
};
