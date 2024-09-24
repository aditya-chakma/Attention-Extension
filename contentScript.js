(() => {
    chrome.runtime.onMessage.addListener((obj, sender, response) => {
        const { type, source } = obj;

        if (source === "fb") {
            removeReels();
            setInterval(removeReels, 2000);
        } else if (source === "yt-home" || source === "yt-watch") {
            removeShorts(source);
            setInterval(removeShorts, 2000);
        }
    });

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
