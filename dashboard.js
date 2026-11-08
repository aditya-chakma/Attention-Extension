// Shared by videos.html, playlist.html and timestamps.html. The page decides
// what to render through the data-page attribute on #content.

// Publish globalThis.ATTENTION_ICONS and globalThis.ATTENTION_STORE (shared with the content script)
import "./icons.js";
import "./bookmarkStore.js";

const STORE = globalThis.ATTENTION_STORE;
const { trash: TRASH_ICON, play: PLAY_ICON, plus: PLUS_ICON, edit: EDIT_ICON, playlist: PLAYLIST_ICON } =
    globalThis.ATTENTION_ICONS.markup;

// Reserved storage keys. Every other key in chrome.storage.sync is a YouTube
// video id holding its timestamp bookmarks.
const TITLES_KEY = "attention_video_titles";
const RESERVED_KEYS = [STORE.VIDEOS_KEY, STORE.PLAYLISTS_KEY, TITLES_KEY];

// How many videos the "Recent" tab shows
const RECENT_LIMIT = 10;

// Paginated lists: "All" videos, a playlist's videos, timestamp groups
const PAGE_SIZES = [10, 15, 25];
// One page-size preference for every list, remembered across visits
const PAGE_SIZE_PREF = "attention.pageSize";

const readPageSize = () => {
    try {
        const size = Number(window.localStorage.getItem(PAGE_SIZE_PREF));
        return PAGE_SIZES.includes(size) ? size : PAGE_SIZES[0];
    } catch {
        return PAGE_SIZES[0];
    }
};

const parseJSON = (raw, fallback) => {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
};

const fetchAllStorage = () => new Promise((resolve) => chrome.storage.sync.get(null, resolve));
const setStorage = (items) => new Promise((resolve) => chrome.storage.sync.set(items, resolve));

const formatTime = (t) => {
    const date = new Date(0);
    date.setSeconds(t);
    return date.toISOString().slice(11, 19);
};

const watchUrl = (videoId, time = 0) => {
    const params = new URLSearchParams({ v: videoId });
    if (time > 0) params.set("t", Math.floor(time) + "s");
    return "https://www.youtube.com/watch?" + params.toString();
};

const playlistUrl = (playlistId) => "playlist.html?" + new URLSearchParams({ id: playlistId }).toString();

// YouTube serves thumbnails for any public video id at this URL; no API key needed
const thumbnailUrl = (videoId) => "https://i.ytimg.com/vi/" + encodeURIComponent(videoId) + "/mqdefault.jpg";

// All user-provided text (titles, channel names, playlist names, descriptions)
// is set via textContent, never innerHTML, so it cannot inject markup into the page.
// innerHTML is only used for the static icon markup from icons.js.
const element = (tag, className, textContent) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent !== undefined) el.textContent = textContent;
    return el;
};

const externalLink = (className, href, textContent) => {
    const link = element("a", className, textContent);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
};

const formatDate = (timestamp) =>
    new Date(timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const pluralize = (count, word) => count + " " + word + (count === 1 ? "" : "s");

const thumbnail = (videoId, href, small = false) => {
    const link = externalLink(small ? "thumb thumb-small" : "thumb", href);
    const img = element("img");
    img.src = thumbnailUrl(videoId);
    img.alt = "";
    img.loading = "lazy";
    link.appendChild(img);
    return link;
};

const iconButton = (className, label, iconMarkup, onClick) => {
    const button = element("button", className);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = iconMarkup;
    button.addEventListener("click", onClick);
    return button;
};

const deleteButton = (onDelete, label = "Delete") => iconButton("delete-btn", label, TRASH_ICON, onDelete);

const loadBookmarks = async () => {
    const [all, library] = await Promise.all([fetchAllStorage(), STORE.loadLibrary()]);
    const titles = parseJSON(all[TITLES_KEY], {});

    const timestamps = {};
    for (const [key, raw] of Object.entries(all)) {
        if (RESERVED_KEYS.includes(key)) continue;
        const value = parseJSON(raw, null);
        if (Array.isArray(value) && value.length > 0) {
            timestamps[key] = value;
        }
    }

    return { ...library, library, titles, timestamps };
};

const titleForVideo = (videoId, { titles, videos }) => {
    const bookmarkedVideo = videos.find((v) => v.id === videoId);
    return STORE.cleanTitle(titles[videoId]) || (bookmarkedVideo && bookmarkedVideo.title) || videoId;
};

// ---- UI state that must survive re-renders (storage changes re-render the page)

const ui = {
    videosView: "recent", // "recent" | "all"
    pageSize: readPageSize(),
    pages: {}, // list key -> current page (1-based)
    scrollToContent: false,
    // null, { mode: "create", value, error } or { mode: "rename", id, value, error }
    playlistForm: null,
};

const openPlaylistForm = (form) => {
    ui.playlistForm = { value: "", error: "", ...form };
    render();
};

const closePlaylistForm = () => {
    ui.playlistForm = null;
    render();
};

/**
 * Inline name form used to create and rename playlists.
 * Enter saves, Escape cancels; validation errors come from bookmarkStore.js.
 */
const playlistNameForm = (submitLabel, onSubmit) => {
    const state = ui.playlistForm;
    const form = element("form", "inline-form");

    const input = element("input");
    input.type = "text";
    input.value = state.value;
    input.maxLength = STORE.MAX_NAME_LENGTH;
    input.placeholder = "Playlist name";
    input.setAttribute("aria-label", "Playlist name");

    const error = element("div", "form-error", state.error);
    error.setAttribute("role", "alert");

    const cancel = element("button", "btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", closePlaylistForm);
    const submit = element("button", "btn btn-primary", submitLabel);
    submit.type = "submit";
    submit.disabled = !state.value.trim();

    const actions = element("div", "form-actions");
    actions.append(cancel, submit);

    input.addEventListener("input", () => {
        state.value = input.value;
        state.error = "";
        error.textContent = "";
        submit.disabled = !input.value.trim();
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePlaylistForm();
    });
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await onSubmit(state.value);
            ui.playlistForm = null;
        } catch (err) {
            state.error = err.message;
        }
        render();
    });

    form.append(input, error, actions);
    return form;
};

const confirmDeletePlaylist = async (playlist, library) => {
    const orphans = STORE.videosOnlyIn(library, playlist.id).length;
    const message = ["The playlist will be deleted. This can't be undone."];
    if (orphans > 0) {
        message.push(
            `${pluralize(orphans, "video")} that ${orphans === 1 ? "is" : "are"} not in any other playlist will also be removed from your bookmarks.`
        );
    }
    const confirmed = await confirmModal({
        title: `Delete "${playlist.name}"?`,
        message,
        confirmLabel: "Delete playlist",
    });
    if (!confirmed) return false;
    await STORE.deletePlaylist(playlist.id);
    return true;
};

/**
 * Rename and delete buttons for a playlist. Favorites and Watch Later are
 * fixed, so they get a "Default" badge explaining why there are no buttons.
 */
const playlistActions = (playlist, { onRename, onDelete }) => {
    if (STORE.isProtected(playlist.id)) {
        const badge = element("span", "default-badge", "Default");
        badge.title = "Built-in playlist: it can't be renamed or deleted";
        return [badge];
    }
    return [
        iconButton("icon-action rename-btn", `Rename ${playlist.name}`, EDIT_ICON, onRename),
        iconButton("icon-action danger delete-playlist-btn", `Delete ${playlist.name}`, TRASH_ICON, onDelete),
    ];
};

// ---- Undo for deleted videos

const UNDO_VISIBLE_MS = 5000;
let undoTimer = null;

/**
 * Floating "Video removed · Undo" bar in the bottom-right corner for 5 seconds.
 * A newer deletion replaces it (the earlier one stays deleted).
 */
const showUndo = (message, snapshot) => {
    let bar = document.querySelector(".undo-bar");
    if (!bar) {
        bar = element("div", "undo-bar");
        bar.setAttribute("role", "status");
        document.body.appendChild(bar);
    }

    const undo = element("button", "undo-btn", "Undo");
    undo.type = "button";
    undo.addEventListener("click", async () => {
        hideUndo();
        await STORE.restoreVideo(snapshot);
    });
    bar.replaceChildren(element("span", "undo-message", message), undo);
    bar.classList.add("visible");

    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, UNDO_VISIBLE_MS);
};

const hideUndo = () => {
    clearTimeout(undoTimer);
    document.querySelector(".undo-bar")?.remove();
};

// ---- Pagination

/** Returns the slice of `items` for the list's current page (clamped, e.g. after deletions). */
const paginate = (items, listKey) => {
    const size = ui.pageSize;
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    const page = Math.min(Math.max(1, ui.pages[listKey] || 1), pageCount);
    ui.pages[listKey] = page;
    const start = (page - 1) * size;
    return { items: items.slice(start, start + size), page, pageCount, start, total: items.length };
};

const goToPage = (listKey, page) => {
    ui.pages[listKey] = page;
    ui.scrollToContent = true;
    render();
};

/** "Per page [10]   11–20 of 37 videos   ‹ Previous  Page 2 of 4  Next ›"; null when a single page is all there is at any size. */
const pager = (listKey, result, noun) => {
    if (result.total <= PAGE_SIZES[0]) return null;

    const nav = element("nav", "pager");
    nav.setAttribute("aria-label", "Pagination");

    const sizeLabel = element("label", "pager-size", "Per page");
    const select = element("select");
    for (const size of PAGE_SIZES) {
        const option = element("option", null, String(size));
        option.value = String(size);
        option.selected = size === ui.pageSize;
        select.appendChild(option);
    }
    select.addEventListener("change", () => {
        ui.pageSize = Number(select.value);
        try {
            window.localStorage.setItem(PAGE_SIZE_PREF, select.value);
        } catch {
            // Preference just won't be remembered
        }
        ui.pages = {}; // page numbers mean something else at a new size
        render();
    });
    sizeLabel.appendChild(select);

    const first = result.start + 1;
    const last = result.start + result.items.length;
    const range = element("span", "pager-range", `${first}–${last} of ${result.total} ${noun}`);

    const prev = element("button", "btn pager-prev", "‹ Previous");
    prev.type = "button";
    prev.disabled = result.page <= 1;
    prev.addEventListener("click", () => goToPage(listKey, result.page - 1));

    const status = element("span", "pager-status", `Page ${result.page} of ${result.pageCount}`);
    status.setAttribute("aria-live", "polite");

    const next = element("button", "btn pager-next", "Next ›");
    next.type = "button";
    next.disabled = result.page >= result.pageCount;
    next.addEventListener("click", () => goToPage(listKey, result.page + 1));

    const controls = element("div", "pager-controls");
    controls.append(prev, status, next);
    nav.append(sizeLabel, range, controls);
    return nav;
};

// ---- Confirmation modal (replaces the browser's confirm())

/**
 * Resolves true when the user confirms. Escape, Cancel and clicking the
 * backdrop resolve false. Focus starts on Cancel (the safe choice), stays
 * inside the modal, and returns to where it was afterwards.
 */
const confirmModal = ({ title, message, confirmLabel }) =>
    new Promise((resolve) => {
        const previouslyFocused = document.activeElement;

        const backdrop = element("div", "modal-backdrop");
        const modal = element("div", "modal");
        modal.setAttribute("role", "alertdialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-labelledby", "modal-title");
        modal.setAttribute("aria-describedby", "modal-message");

        const heading = element("h2", "modal-title", title);
        heading.id = "modal-title";
        const body = element("div", "modal-message");
        body.id = "modal-message";
        for (const paragraph of [].concat(message)) body.appendChild(element("p", null, paragraph));

        const cancel = element("button", "btn", "Cancel");
        cancel.type = "button";
        const confirm = element("button", "btn btn-danger", confirmLabel);
        confirm.type = "button";
        const actions = element("div", "modal-actions");
        actions.append(cancel, confirm);

        modal.append(heading, body, actions);
        backdrop.appendChild(modal);

        const close = (result) => {
            document.removeEventListener("keydown", onKeydown, true);
            backdrop.remove();
            if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
            resolve(result);
        };
        const onKeydown = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                close(false);
            } else if (e.key === "Tab") {
                // Only two focusable elements: keep focus cycling between them
                e.preventDefault();
                (document.activeElement === cancel ? confirm : cancel).focus();
            }
        };

        cancel.addEventListener("click", () => close(false));
        confirm.addEventListener("click", () => close(true));
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) close(false);
        });
        document.addEventListener("keydown", onKeydown, true);

        document.body.appendChild(backdrop);
        cancel.focus();
    });

// ---- Video cards (bookmarked videos list and playlist page)

const videoCard = (video, data, { onDelete, deleteLabel }) => {
    const item = element("li", "card video-card");
    // Opens the video from the start; the position it was saved at isn't used
    const url = watchUrl(video.id);

    const body = element("div", "card-body");
    body.appendChild(externalLink("card-title", url, video.title || video.id));
    if (video.channel) {
        body.appendChild(element("div", "card-channel", video.channel));
    }
    // When it was bookmarked
    body.appendChild(element("div", "card-meta", "Saved " + formatDate(video.savedAt)));

    const inPlaylists = STORE.playlistsContaining(data.library, video.id);
    if (inPlaylists.length > 0) {
        const chips = element("div", "card-playlists");
        for (const playlist of inPlaylists) {
            const chip = element("a", "chip", playlist.name);
            chip.href = playlistUrl(playlist.id);
            chips.appendChild(chip);
        }
        body.appendChild(chips);
    }

    item.append(thumbnail(video.id, url), body, deleteButton(onDelete, deleteLabel));
    return item;
};

// ---- videos.html: bookmarked videos (left) and playlists (right)

const renderVideosColumn = (data) => {
    const column = element("section", "split-main");
    column.setAttribute("aria-label", "Bookmarked videos");

    const header = element("div", "section-header");
    header.appendChild(element("h2", "section-title", "Bookmarked videos"));

    const views = element("div", "segmented");
    views.setAttribute("role", "tablist");
    views.setAttribute("aria-label", "Which videos to show");
    for (const [view, label] of [
        ["recent", "Recent"],
        ["all", `All (${data.videos.length})`],
    ]) {
        const tab = element("button", "segment", label);
        tab.type = "button";
        tab.dataset.view = view;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(ui.videosView === view));
        tab.addEventListener("click", () => {
            ui.videosView = view;
            render();
        });
        views.appendChild(tab);
    }
    header.appendChild(views);
    column.appendChild(header);

    if (data.videos.length === 0) {
        column.appendChild(
            element(
                "p",
                "empty",
                "No bookmarked videos yet. Use the bookmark button in the YouTube player to save a video to a playlist."
            )
        );
        return column;
    }

    const newestFirst = [...data.videos].sort((a, b) => b.savedAt - a.savedAt);
    // Recent is a fixed glance at the newest few; All is paged
    const paged = ui.videosView === "all" ? paginate(newestFirst, "videos-all") : null;
    const shown = paged ? paged.items : newestFirst.slice(0, RECENT_LIMIT);

    const list = element("ul", "cards");
    for (const video of shown) {
        list.appendChild(
            videoCard(video, data, {
                // Removes the bookmark and takes the video out of every playlist; no confirmation, Undo instead
                onDelete: async () => showUndo("Video removed", await STORE.removeVideo(video.id)),
            })
        );
    }
    column.appendChild(list);

    const pages = paged && pager("videos-all", paged, "videos");
    if (pages) column.appendChild(pages);

    if (ui.videosView === "recent" && newestFirst.length > shown.length) {
        const more = element("button", "link-btn", `Show all ${newestFirst.length} videos`);
        more.type = "button";
        more.addEventListener("click", () => {
            ui.videosView = "all";
            render();
        });
        column.appendChild(more);
    }
    return column;
};

const playlistThumb = (playlist) => {
    const box = element("a", "playlist-thumb");
    box.href = playlistUrl(playlist.id);
    box.setAttribute("aria-hidden", "true");
    box.tabIndex = -1;
    const latest = playlist.videoIds[playlist.videoIds.length - 1];
    if (latest) {
        const img = element("img");
        img.src = thumbnailUrl(latest);
        img.alt = "";
        img.loading = "lazy";
        box.appendChild(img);
    } else {
        box.innerHTML = PLAYLIST_ICON;
    }
    return box;
};

const renderPlaylistsColumn = (data) => {
    const column = element("aside", "split-side");
    column.setAttribute("aria-label", "Playlists");

    const header = element("div", "section-header");
    header.appendChild(element("h2", "section-title", "Playlists"));
    const add = element("button", "btn new-playlist-btn");
    add.type = "button";
    add.innerHTML = PLUS_ICON;
    add.appendChild(element("span", null, "New playlist"));
    add.addEventListener("click", () => openPlaylistForm({ mode: "create" }));
    header.appendChild(add);
    column.appendChild(header);

    if (ui.playlistForm?.mode === "create") {
        column.appendChild(playlistNameForm("Create", (name) => STORE.createPlaylist(name)));
    }

    const list = element("ul", "playlists");
    for (const playlist of data.playlists) {
        const row = element("li", "playlist-row");
        row.dataset.playlistId = playlist.id;

        if (ui.playlistForm?.mode === "rename" && ui.playlistForm.id === playlist.id && !STORE.isProtected(playlist.id)) {
            row.classList.add("editing");
            row.appendChild(playlistNameForm("Save", (name) => STORE.renamePlaylist(playlist.id, name)));
            list.appendChild(row);
            continue;
        }

        const info = element("div", "playlist-info");
        const name = element("a", "playlist-name", playlist.name);
        name.href = playlistUrl(playlist.id);
        info.append(name, element("span", "playlist-count", pluralize(playlist.videoIds.length, "video")));

        row.append(
            playlistThumb(playlist),
            info,
            ...playlistActions(playlist, {
                onRename: () => openPlaylistForm({ mode: "rename", id: playlist.id, value: playlist.name }),
                onDelete: () => confirmDeletePlaylist(playlist, data.library),
            })
        );
        list.appendChild(row);
    }
    column.appendChild(list);

    if (data.playlists.length === 0 && ui.playlistForm?.mode !== "create") {
        column.appendChild(element("p", "empty", "No playlists. Create one to organize your bookmarked videos."));
    }
    return column;
};

const renderVideos = (panel, data) => {
    const layout = element("div", "split");
    layout.append(renderVideosColumn(data), renderPlaylistsColumn(data));
    panel.replaceChildren(layout);
};

// ---- playlist.html?id=...: the videos of one playlist

const renderPlaylist = (panel, data) => {
    const playlistId = new URLSearchParams(window.location.search).get("id");
    const playlist = data.playlists.find((p) => p.id === playlistId);

    const back = element("a", "back-link", "← All bookmarks");
    back.href = "videos.html";

    if (!playlist) {
        document.title = "Attention — Playlist not found";
        panel.replaceChildren(back, element("p", "empty", "This playlist doesn't exist anymore."));
        return;
    }
    document.title = "Attention — " + playlist.name;

    const header = element("div", "playlist-header");
    if (ui.playlistForm?.mode === "rename" && ui.playlistForm.id === playlist.id && !STORE.isProtected(playlist.id)) {
        header.appendChild(playlistNameForm("Save", (name) => STORE.renamePlaylist(playlist.id, name)));
    } else {
        const titles = element("div", "playlist-heading");
        titles.append(
            element("h2", "playlist-title", playlist.name),
            element("span", "playlist-count", pluralize(playlist.videoIds.length, "video"))
        );
        header.append(
            titles,
            ...playlistActions(playlist, {
                onRename: () => openPlaylistForm({ mode: "rename", id: playlist.id, value: playlist.name }),
                onDelete: async () => {
                    if (await confirmDeletePlaylist(playlist, data.library)) window.location.href = "videos.html";
                },
            })
        );
    }

    panel.replaceChildren(back, header);

    // Newest additions first, like the rest of the dashboard
    const videos = [...playlist.videoIds]
        .reverse()
        .map((id) => data.videos.find((v) => v.id === id))
        .filter(Boolean);

    if (videos.length === 0) {
        panel.appendChild(
            element("p", "empty", "No videos in this playlist yet. Use the bookmark button in the YouTube player to add one.")
        );
        return;
    }

    const listKey = "playlist:" + playlist.id;
    const paged = paginate(videos, listKey);
    const list = element("ul", "cards");
    for (const video of paged.items) {
        list.appendChild(
            videoCard(video, data, {
                deleteLabel: "Remove from playlist",
                onDelete: async () => {
                    const { snapshot } = await STORE.removeVideoFromPlaylist(video.id, playlist.id);
                    showUndo("Removed from " + playlist.name, snapshot);
                },
            })
        );
    }
    panel.appendChild(list);
    const pages = pager(listKey, paged, "videos");
    if (pages) panel.appendChild(pages);
};

// ---- timestamps.html: timestamp bookmarks grouped per video

const renderTimestamps = (panel, data) => {
    panel.innerHTML = "";

    const videoIds = Object.keys(data.timestamps);
    if (videoIds.length === 0) {
        panel.appendChild(
            element("p", "empty", "No bookmarked timestamps yet. Use the bookmark button in the YouTube player to save one.")
        );
        return;
    }

    const paged = paginate(videoIds, "timestamps");
    for (const videoId of paged.items) {
        const group = element("section", "group");

        // One thumbnail per video, next to its title; individual timestamps stay text-only
        const header = element("div", "group-header");
        header.append(
            thumbnail(videoId, watchUrl(videoId), true),
            element("h2", "group-title", titleForVideo(videoId, data))
        );
        group.appendChild(header);

        const list = element("ul", "cards");
        for (const bookmark of data.timestamps[videoId]) {
            const item = element("li", "card");

            const openLink = externalLink("open-link", watchUrl(videoId, bookmark.time));
            openLink.title = "Open at " + formatTime(bookmark.time);
            openLink.innerHTML = PLAY_ICON;
            openLink.appendChild(element("span", null, formatTime(bookmark.time)));

            const deleteBtn = deleteButton(async () => {
                const current = parseJSON((await fetchAllStorage())[videoId], []);
                await setStorage({ [videoId]: JSON.stringify(current.filter((b) => b.time != bookmark.time)) });
            });

            item.append(element("span", "card-title", bookmark.desc), openLink, deleteBtn);
            list.appendChild(item);
        }

        group.appendChild(list);
        panel.appendChild(group);
    }

    const pages = pager("timestamps", paged, "videos");
    if (pages) panel.appendChild(pages);
};

// ---- Rendering

const RENDERERS = { videos: renderVideos, playlist: renderPlaylist, timestamps: renderTimestamps };

// Renders can overlap (several storage changes in a row); only the latest one paints
let renderSeq = 0;

const render = async () => {
    const content = document.getElementById("content");
    if (!content) return;

    const seq = ++renderSeq;
    const data = await loadBookmarks();
    if (seq !== renderSeq) return;

    (RENDERERS[content.dataset.page] || renderVideos)(content, data);

    // After Previous/Next, start reading the new page from its top
    if (ui.scrollToContent) {
        ui.scrollToContent = false;
        content.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }

    // Keep typing in an open create/rename form after a re-render
    const input = content.querySelector(".inline-form input");
    if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
};

document.addEventListener("DOMContentLoaded", render);

// Keep the page in sync with bookmarks added or removed anywhere (player
// buttons, popup, another dashboard tab) without a reload
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") render();
});
