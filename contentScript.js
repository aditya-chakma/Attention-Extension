(() => {
  removeShorts();
  setInterval(removeShorts, 2000);

  removeReels();
  setInterval(removeReels, 2000);

  function removeShorts() {
    shorts = document.querySelectorAll("ytd-rich-section-renderer");

    if (shorts && shorts.length > 0) {
      shorts.forEach((el) => el.remove());

      console.log(
        "Attention extension has removed " + shorts.length + " shorts"
      );
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
