// Runs on youtube.com and facebook.com at document_start (see manifest.json),
// after icons.js, bookmarkStore.js and settingsStore.js:
//  - removes YouTube Shorts shelves / Facebook Reels sections (unless switched
//    off in Settings), see hide.css for the instant pre-hide
//  - sends in-app navigation to a Shorts/Reels page to the home page (direct
//    loads are redirected earlier by background.js rules)
//  - adds the timestamp and "Save to playlist" buttons to the YouTube player
// Site blocking lives in background.js (declarativeNetRequest rules built from
// the settings); this script only runs on pages that were allowed through.
(() => {
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

    // ---- Shorts / Reels toggles (settingsStore.js, globalThis.ATTENTION_SETTINGS)
    // hide.css hides the sections unless the <html> element carries the
    // matching "show" attribute, so the default (hidden) needs no JavaScript
    // and the toggle off just adds an attribute. Removal from the DOM below is
    // skipped for a toggle that is off.
    const SETTINGS = globalThis.ATTENTION_SETTINGS;
    const TOGGLE_FOR_SOURCE = { "fb": "facebookReels", "yt-home": "youtubeShorts", "yt-watch": "youtubeShorts" };
    const SHOW_ATTRIBUTES = { youtubeShorts: "data-attention-show-shorts", facebookReels: "data-attention-show-reels" };

    // Until the settings are read the sections are hidden by hide.css but not
    // removed: removal can't be undone, and at document_start the page can be
    // parsed before the storage read resolves
    let hideToggles = { youtubeShorts: true, facebookReels: true };
    let togglesKnown = false;

    const removalEnabled = (source) => togglesKnown && Boolean(source && hideToggles[TOGGLE_FOR_SOURCE[source]]);

    const applyHideToggles = (toggles) => {
        togglesKnown = true;
        hideToggles = { ...hideToggles, ...toggles };
        for (const [toggle, attribute] of Object.entries(SHOW_ATTRIBUTES)) {
            document.documentElement.toggleAttribute(attribute, !hideToggles[toggle]);
        }
        // Switched on while the page is open: catch what is already there
        if (leaveShortsReelsPage()) return;
        if (removalEnabled(activeSource)) sweep();
    };

    const loadHideToggles = () =>
        SETTINGS.loadSettings()
            .then((settings) => applyHideToggles(settings.hideShortsReels))
            .catch(() => applyHideToggles({})); // unreadable settings: keep the defaults

    loadHideToggles();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && SETTINGS.SETTINGS_KEY in changes) loadHideToggles();
    });

    // ---- Removal statistics (recorded by background.js, see statsStore.js)
    // Each removed section is counted by the Shorts/Reels it holds: the
    // distinct /shorts/<id> or /reel/<id> links in it. A section removed
    // before YouTube/Facebook filled it in still counts as one, so the totals
    // are a lower bound.
    const STATS_MESSAGE = "STATS_EVENT";
    const KIND_FOR_SOURCE = { "fb": "reels", "yt-home": "shorts", "yt-watch": "shorts" };
    const ITEM_LINK_PATTERNS = { shorts: /\/shorts\/([^/?#]+)/, reels: /\/reels?\/([^/?#]+)/ };

    const countItems = (section, kind) => {
        const ids = new Set();
        for (const link of section.querySelectorAll("a[href]")) {
            const match = link.getAttribute("href").match(ITEM_LINK_PATTERNS[kind]);
            if (match) ids.add(match[1]);
        }
        return Math.max(1, ids.size);
    };

    const reportStat = (event) => {
        try {
            chrome.runtime.sendMessage({ type: STATS_MESSAGE, event })?.catch(() => {});
        } catch {
            // The extension was reloaded or updated: this page's script is orphaned
        }
    };

    const reportRemoval = (kind, count) => reportStat({ event: "removal", kind, count });

    // ---- Shorts / Reels pages ----------------------------------------------
    // A Shorts or Reels page (youtube.com/shorts/..., facebook.com/reel/...)
    // is left for the site's home page while its toggle is on. Loading one
    // directly is handled by background.js rules, which redirect to the home
    // page with a #attention-redirect=<kind> marker counted here. Both sites
    // are SPAs, though: opening a Short from inside YouTube only changes the
    // URL with history.pushState, which no network rule sees, so URL changes
    // are watched here too.
    const KIND_FOR_TOGGLE = { youtubeShorts: "shorts", facebookReels: "reels" };
    const MARKER_PATTERN = new RegExp(`^#${SETTINGS.REDIRECT_MARKER}=(shorts|reels)$`);

    // The page being left; location.replace() takes a moment, and several
    // triggers (URL change, yt-navigate-finish...) can fire meanwhile
    let leavingHref = null;

    /** Leaves a Shorts/Reels page whose toggle is on; true when it does. */
    function leaveShortsReelsPage() {
        const href = window.location.href;
        const toggle = SETTINGS.shortsReelsToggleFor(href);
        if (!toggle) {
            leavingHref = null;
            return false;
        }
        // Until the settings are read the toggle is unknown; applyHideToggles
        // calls this again once it is
        if (!togglesKnown || !hideToggles[toggle]) return false;
        if (leavingHref === href) return true;

        leavingHref = href;
        reportStat({ event: "redirect", kind: KIND_FOR_TOGGLE[toggle] });
        // replace(): Back shouldn't return to the Short only to bounce again
        window.location.replace(window.location.origin + "/");
        return true;
    }

    // Arrived through a background.js redirect: count it once and tidy the
    // address bar (a reload then no longer carries the marker)
    const consumeRedirectMarker = () => {
        const match = window.location.hash.match(MARKER_PATTERN);
        if (!match) return;
        history.replaceState(history.state, "", window.location.pathname + window.location.search);
        reportStat({ event: "redirect", kind: match[1] });
    };

    let lastHref = window.location.href;
    const onUrlMaybeChanged = () => {
        if (window.location.href === lastHref) return;
        lastHref = window.location.href;
        leaveShortsReelsPage();
    };

    consumeRedirectMarker();
    // The Navigation API reports every same-document URL change, including
    // pushState from the page's own scripts; popstate covers Back/Forward and
    // the DOM observer below is the fallback where neither fires
    window.navigation?.addEventListener("currententrychange", onUrlMaybeChanged);
    window.addEventListener("popstate", onUrlMaybeChanged);

    let activeSource = null;
    let sweepScheduled = false;
    let domObserver = null;

    function sweep() {
        sweepScheduled = false;
        if (!removalEnabled(activeSource)) return;

        const nodes = document.querySelectorAll(REMOVAL_SELECTORS[activeSource]);
        if (nodes.length > 0) {
            const kind = KIND_FOR_SOURCE[activeSource];
            let items = 0;
            nodes.forEach((el) => {
                items += countItems(el, kind);
                el.remove();
            });
            reportRemoval(kind, items);
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
            domObserver = new MutationObserver(() => {
                onUrlMaybeChanged();
                scheduleSweep();
            });
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

            // The script runs at document_start, when <body> may not exist yet
            observer.observe(document.documentElement, {
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
            if (videoId !== currentVideo) closeSaveDialog();
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
            chrome.storage.local.set({ [currentVideo]: JSON.stringify(currentVideoBookmarks) }, () => {
                response(currentVideoBookmarks);
            });
            return true;
        }
        return false;
    }

    const fetchBookmarks = () => {
        return new Promise((resolve) => {
            chrome.storage.local.get([currentVideo], (obj) => {
                resolve(obj[currentVideo] ? JSON.parse(obj[currentVideo]) : []);
            });
        });
    };

    // Storage keys reserved by the dashboard; plain video ids hold their
    // timestamp bookmark lists. Videos and playlists are managed through
    // bookmarkStore.js (globalThis.ATTENTION_STORE).
    const STORE = globalThis.ATTENTION_STORE;
    const TITLES_KEY = "attention_video_titles";

    const fetchStoredJSON = (key, fallback) => {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (obj) => {
                resolve(obj[key] ? JSON.parse(obj[key]) : fallback);
            });
        });
    };

    // Prefer the title shown on the page; the tab title carries YouTube's
    // notification count ("(1) Video name - YouTube"), stripped as a fallback
    const getVideoTitle = () => {
        const heading = document.querySelector("ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata");
        const fromPage = heading && heading.textContent.trim();
        return fromPage || STORE.cleanTitle(document.title.replace(/ - YouTube$/, "").trim());
    };

    const getChannelName = () => {
        const link = document.querySelector(
            "#owner #channel-name a, ytd-video-owner-renderer #channel-name a, ytd-channel-name a"
        );
        if (link && link.textContent.trim()) {
            return link.textContent.trim();
        }
        const meta = document.querySelector('span[itemprop="author"] link[itemprop="name"]');
        return meta ? (meta.getAttribute("content") || "").trim() : "";
    };

    const newVideoLoaded = async () => {
        currentVideoBookmarks = await fetchBookmarks();

        // Always update references to ensure we point to the active player element on SPA transitions
        youtubeLeftControls = await waitForElement("ytp-left-controls");
        youtubePlayer = await waitForElement("video-stream");

        if (!youtubeLeftControls || !youtubePlayer) return;

        if (!document.getElementsByClassName("attention-player-controls")[0]) {
            const container = document.createElement("div");
            container.className = "attention-player-controls";
            container.append(
                createPlayerButton("bookmark-btn", TIMESTAMP_BUTTON_LABEL, "timestampBookmark", addNewBookmarkEventHandler),
                createPlayerButton("video-bookmark-btn", VIDEO_BUTTON_LABEL, "videoBookmark", bookmarkVideoEventHandler)
            );
            youtubeLeftControls.appendChild(container);
        }

        // The buttons persist across SPA navigations, so re-sync for every video
        renderVideoBookmarkState((await STORE.loadLibrary()).videos);
    };

    const TIMESTAMP_BUTTON_LABEL = "Click to bookmark current timestamp";
    const VIDEO_BUTTON_LABEL = "Save this video to a playlist";
    const VIDEO_BUTTON_SAVED_LABEL = "Saved. Click to change playlists";

    // <button class="ytp-button"> mirrors YouTube's own player buttons so it picks
    // up their reset, cursor and hover opacity; player-buttons.css does the rest.
    // Icons come from icons.js (globalThis.ATTENTION_ICONS).
    const createPlayerButton = (className, label, iconName, onClick) => {
        const button = document.createElement("button");
        button.className = "ytp-button attention-player-btn " + className;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.appendChild(ATTENTION_ICONS.createIcon(iconName));
        button.addEventListener("click", onClick);
        return button;
    };

    // Solid bookmark icon when the current video is in the bookmarked list
    const renderVideoBookmarkState = (videos) => {
        const button = document.querySelector(".attention-player-controls .video-bookmark-btn");
        if (!button) return;

        const saved = videos.some((v) => v.id === currentVideo);
        const label = saved ? VIDEO_BUTTON_SAVED_LABEL : VIDEO_BUTTON_LABEL;
        ATTENTION_ICONS.setIcon(button.querySelector("svg"), saved ? "videoBookmarked" : "videoBookmark");
        button.dataset.saved = String(saved);
        button.title = label;
        button.setAttribute("aria-label", label);
    };

    // Brief confirmation shown in the player after a bookmark action.
    // Styled by player-buttons.css; reuses one element per player.
    const TOAST_HIDE_DELAY_MS = 2000;
    let toastHideTimer = null;

    const showToast = (message) => {
        const host = (youtubePlayer && youtubePlayer.closest(".html5-video-player")) || document.body;

        let toast = document.querySelector(".attention-toast");
        if (!toast || toast.parentElement !== host) {
            if (toast) toast.remove();
            toast = document.createElement("div");
            toast.className = "attention-toast";
            toast.setAttribute("role", "status");
            host.appendChild(toast);
        }

        toast.textContent = message;
        toast.classList.add("attention-toast-visible");
        clearTimeout(toastHideTimer);
        toastHideTimer = setTimeout(() => toast.classList.remove("attention-toast-visible"), TOAST_HIDE_DELAY_MS);
    };

    // Two bookmarks are "the same" when they show the same hh:mm:ss, which is
    // what happens when clicking repeatedly on a paused video. Duplicates can't
    // be told apart in the lists, and DELETE would remove them all at once.
    const isSameTimestamp = (a, b) => Math.floor(a) === Math.floor(b);

    // Clicks are processed one at a time; otherwise two quick clicks could both
    // read storage before either writes and still save a duplicate.
    let timestampSaveQueue = Promise.resolve();

    const addNewBookmarkEventHandler = () => {
        if (!youtubePlayer) return;
        // Capture at click time, not when the queued save runs
        const currentTime = youtubePlayer.currentTime;
        const videoId = currentVideo;

        timestampSaveQueue = timestampSaveQueue.then(() => saveTimestamp(videoId, currentTime)).catch(() => {});
        return timestampSaveQueue;
    };

    const saveTimestamp = async (videoId, currentTime) => {
        const bookmarks = await fetchStoredJSON(videoId, []);
        if (videoId === currentVideo) currentVideoBookmarks = bookmarks;

        if (bookmarks.some((b) => isSameTimestamp(b.time, currentTime))) {
            showToast("Already bookmarked at " + getTime(currentTime));
            return;
        }

        const newBookmark = {
            time: currentTime,
            desc: "Bookmark at " + getTime(currentTime),
        };
        const titles = await fetchStoredJSON(TITLES_KEY, {});
        titles[videoId] = getVideoTitle();

        await new Promise((resolve) =>
            chrome.storage.local.set(
                {
                    [videoId]: JSON.stringify([...bookmarks, newBookmark].sort((a, b) => a.time - b.time)),
                    [TITLES_KEY]: JSON.stringify(titles),
                },
                resolve
            )
        );
        showToast("Bookmarked at " + getTime(currentTime));
    };

    // ---- "Save to playlist" panel -------------------------------------------
    // Opened by the video bookmark button. Lives inside the player (so it also
    // works in fullscreen) and works like YouTube's own "Save to..." dialog:
    // each checkbox saves/removes immediately. Styled by player-buttons.css.

    let saveDialog = null; // the panel element while open
    // Survives re-renders triggered by storage changes while the panel is open
    let dialogState = { creating: false, name: "", error: "" };

    const playerHost = () => (youtubePlayer && youtubePlayer.closest(".html5-video-player")) || document.body;
    const videoBookmarkButton = () => document.querySelector(".attention-player-controls .video-bookmark-btn");

    const currentVideoEntry = () => ({
        id: currentVideo,
        title: getVideoTitle(),
        channel: getChannelName(),
        time: youtubePlayer ? youtubePlayer.currentTime : 0,
        savedAt: Date.now(),
    });

    const bookmarkVideoEventHandler = () => {
        // YouTube can rebuild the player and drop the panel; treat that as closed
        if (saveDialog && !saveDialog.isConnected) closeSaveDialog();
        return saveDialog ? closeSaveDialog() : openSaveDialog();
    };

    // Keep the player from reacting to interaction inside the panel (clicks
    // toggling playback, typed letters triggering YouTube's keyboard shortcuts)
    const ISOLATED_EVENTS = ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "keydown", "keyup", "keypress"];

    const openSaveDialog = async () => {
        if (!youtubePlayer || saveDialog) return;

        dialogState = { creating: false, name: "", error: "" };
        saveDialog = document.createElement("div");
        saveDialog.className = "attention-save-dialog";
        saveDialog.setAttribute("role", "dialog");
        saveDialog.setAttribute("aria-label", "Save to playlist");
        for (const type of ISOLATED_EVENTS) saveDialog.addEventListener(type, (e) => e.stopPropagation());

        const host = playerHost();
        host.appendChild(saveDialog);
        // Moves the toast out from behind the panel (see player-buttons.css)
        host.classList.add("attention-panel-open");
        positionSaveDialog(host);
        videoBookmarkButton()?.setAttribute("aria-expanded", "true");

        document.addEventListener("pointerdown", onPointerDownOutsideDialog, true);
        document.addEventListener("keydown", onDialogEscape, true);

        await renderSaveDialog();
        saveDialog?.querySelector("input")?.focus();
    };

    const closeSaveDialog = () => {
        if (!saveDialog) return;
        saveDialog.parentElement?.classList.remove("attention-panel-open");
        saveDialog.remove();
        saveDialog = null;
        videoBookmarkButton()?.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", onPointerDownOutsideDialog, true);
        document.removeEventListener("keydown", onDialogEscape, true);
    };

    const onPointerDownOutsideDialog = (e) => {
        const button = videoBookmarkButton();
        // The bookmark button toggles the panel itself
        if (saveDialog && !saveDialog.contains(e.target) && !(button && button.contains(e.target))) closeSaveDialog();
    };

    const onDialogEscape = (e) => {
        if (e.key !== "Escape" || !saveDialog) return;
        e.stopPropagation();
        if (dialogState.creating) {
            dialogState = { creating: false, name: "", error: "" };
            renderSaveDialog();
        } else {
            closeSaveDialog();
            videoBookmarkButton()?.focus();
        }
    };

    // Opens upward from the bookmark button, clamped inside the player
    const positionSaveDialog = (host) => {
        const button = videoBookmarkButton();
        if (!button || host === document.body) return;
        const hostRect = host.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const gap = 8;
        saveDialog.style.left = Math.max(12, buttonRect.left - hostRect.left) + "px";
        saveDialog.style.bottom = Math.max(0, hostRect.bottom - buttonRect.top + gap) + "px";
        saveDialog.style.maxHeight = Math.max(160, buttonRect.top - hostRect.top - gap * 2) + "px";
    };

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const iconButton = (className, label, iconName) => {
        const button = el("button", className);
        button.type = "button";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.appendChild(ATTENTION_ICONS.createIcon(iconName));
        return button;
    };

    const renderSaveDialog = async () => {
        const library = await STORE.loadLibrary();
        if (!saveDialog) return; // closed while loading

        const videoId = currentVideo;
        const hadFocusInInput = saveDialog.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
        saveDialog.replaceChildren();

        const header = el("div", "attention-save-header");
        const close = iconButton("attention-dialog-close", "Close", "close");
        close.addEventListener("click", closeSaveDialog);
        header.append(el("span", "attention-save-title", "Save to…"), close);

        const list = el("ul", "attention-playlist-options");
        for (const playlist of library.playlists) {
            const item = el("li");
            const label = el("label", "attention-playlist-option");
            const checkbox = el("input");
            checkbox.type = "checkbox";
            checkbox.dataset.playlistId = playlist.id;
            checkbox.checked = playlist.videoIds.includes(videoId);
            checkbox.addEventListener("change", () => onPlaylistToggled(checkbox, playlist));
            label.append(checkbox, el("span", "attention-playlist-name", playlist.name));
            item.appendChild(label);
            list.appendChild(item);
        }
        if (library.playlists.length === 0) {
            list.appendChild(el("li", "attention-playlist-empty", "No playlists yet"));
        }

        saveDialog.append(header, list, renderNewPlaylistSection());

        if (library.videos.some((v) => v.id === videoId)) {
            const remove = el("button", "attention-remove-bookmark", "Remove from all");
            remove.type = "button";
            remove.addEventListener("click", onRemoveBookmark);
            saveDialog.appendChild(remove);
        }

        if (dialogState.creating && hadFocusInInput) saveDialog.querySelector("input[type=text]")?.focus();
    };

    const renderNewPlaylistSection = () => {
        const section = el("div", "attention-new-playlist");

        if (!dialogState.creating) {
            const start = el("button", "attention-new-playlist-btn");
            start.type = "button";
            start.append(ATTENTION_ICONS.createIcon("add"), el("span", null, "New playlist"));
            start.addEventListener("click", () => {
                dialogState = { creating: true, name: "", error: "" };
                renderSaveDialog().then(() => saveDialog?.querySelector("input[type=text]")?.focus());
            });
            section.appendChild(start);
            return section;
        }

        const form = el("form", "attention-new-playlist-form");
        const input = el("input");
        input.type = "text";
        input.placeholder = "Playlist name";
        input.maxLength = STORE.MAX_NAME_LENGTH;
        input.value = dialogState.name;
        input.setAttribute("aria-label", "New playlist name");

        const actions = el("div", "attention-form-actions");
        const cancel = el("button", "attention-text-btn", "Cancel");
        cancel.type = "button";
        const create = el("button", "attention-text-btn attention-primary", "Create");
        create.type = "submit";
        create.disabled = !dialogState.name.trim();
        actions.append(cancel, create);

        input.addEventListener("input", () => {
            dialogState.name = input.value;
            dialogState.error = "";
            create.disabled = !input.value.trim();
            error.textContent = "";
        });
        cancel.addEventListener("click", () => {
            dialogState = { creating: false, name: "", error: "" };
            renderSaveDialog();
        });
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            onCreatePlaylist();
        });

        const error = el("div", "attention-form-error", dialogState.error);
        error.setAttribute("role", "alert");
        form.append(input, error, actions);
        section.appendChild(form);
        return section;
    };

    const onPlaylistToggled = async (checkbox, playlist) => {
        checkbox.disabled = true;
        try {
            if (checkbox.checked) {
                await STORE.addVideoToPlaylist(currentVideoEntry(), playlist.id);
                showToast("Saved to " + playlist.name);
            } else {
                const { removedBookmark } = await STORE.removeVideoFromPlaylist(currentVideo, playlist.id);
                showToast(removedBookmark ? "Removed from " + playlist.name + ". Bookmark removed" : "Removed from " + playlist.name);
            }
        } catch (error) {
            checkbox.checked = !checkbox.checked;
            showToast(error.message);
        } finally {
            checkbox.disabled = false;
        }
    };

    const onCreatePlaylist = async () => {
        try {
            const playlist = await STORE.createPlaylist(dialogState.name, currentVideoEntry());
            closeSaveDialog();
            showToast(`Bookmarked and playlist "${playlist.name}" created`);
        } catch (error) {
            // Keep the panel open with what was typed and show why
            dialogState.error = error.message;
            await renderSaveDialog();
        }
    };

    const onRemoveBookmark = async () => {
        await STORE.removeVideo(currentVideo);
        closeSaveDialog();
        showToast("Removed from all playlists");
    };

    // YouTube is an SPA: react to its own navigation event instead of waiting for
    // a background message (which can race with content script injection on load)
    const onYouTubeNavigation = () => {
        if (leaveShortsReelsPage()) return;
        const source = window.location.href.includes("watch") ? "yt-watch" : "yt-home";
        startRemoval(source);

        if (source === "yt-watch") {
            const videoId = new URLSearchParams(window.location.search).get("v");
            if (videoId) {
                if (videoId !== currentVideo) closeSaveDialog();
                currentVideo = videoId;
                newVideoLoaded();
            }
        }
    };

    // Reels removal must not depend on the background message: the very first
    // navigation can race extension startup and its tabs.onUpdated events can
    // be missed entirely (YouTube already self-starts the same way below)
    if (window.location.hostname.includes("facebook.com")) {
        startRemoval("fb");
    }

    if (window.location.hostname.includes("youtube.com")) {
        onYouTubeNavigation();
        document.addEventListener("yt-navigate-finish", onYouTubeNavigation);

        // Keeps the bookmark icon and an open panel in sync with saves from the
        // panel and with changes made on the dashboard (possibly in another tab)
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return;
            if (STORE.VIDEOS_KEY in changes) {
                const { newValue } = changes[STORE.VIDEOS_KEY];
                renderVideoBookmarkState(newValue ? JSON.parse(newValue) : []);
            }
            if (saveDialog && (STORE.VIDEOS_KEY in changes || STORE.PLAYLISTS_KEY in changes)) renderSaveDialog();
        });
    }
})();

const getTime = (t) => {
    var date = new Date(0);
    date.setSeconds(t);

    return date.toISOString().slice(11, 19);
};
