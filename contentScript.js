(() => {
  removeShorts();
  setInterval(removeShorts, 2000);

  function removeShorts() {
    shorts = document.querySelectorAll("ytd-rich-section-renderer");

    if (shorts && shorts.length > 0) {
      shorts.forEach((el) => el.remove());

      console.log(
        "Attention extension has removed " + shorts.length + " shorts"
      );
    }
  }
})();
