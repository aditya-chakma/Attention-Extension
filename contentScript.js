(() => {
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
                bookMark(obj);
            }
            removeShorts(source);
            intervalId = setInterval(removeShorts, 2000);
        }
    });

    function bookMark(obj) {
        const { source, videoId } = obj;

        if (source !== "yt-watch") {
            return;
        }

        currentVideo = videoId;
        newVideoLoaded();
    }

    const newVideoLoaded = async () => {
        const bookmarkBtnExist = document.getElementsByClassName("bookmark-btn")[0];

        console.log("yt-watch content");

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

    const addNewBookmarkEventHandler = () => {
        const currentTime = youtubePlayer.currentTime;
        const newBookmark = {
            time: currentTime,
            desc: "Bookmark at " + currentTime,
        };

        console.log(newBookmark);

        chrome.storage.sync.set({
            [currentVideo]: JSON.stringify([...currentVideoBookmarks, newBookmark].sort((a, b) => a.time - b.time)),
        });
    };
})();

const getTime = (t) => {
    var date = new Date(0);
    date.setSeconds(t);

    return date.toISOString().substr(11, 8);
};
