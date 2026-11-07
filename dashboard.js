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
    return titles[videoId] || (bookmarkedVideo && bookmarkedVideo.title) || videoId;
};

// ---- UI state that must survive re-renders (storage changes re-render the page)

const ui = {
    videosView: "recent", // "recent" | "all"
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
    const message =
        `Delete the playlist "${playlist.name}"?` +
        (orphans > 0
            ? `\n\n${pluralize(orphans, "video")} that ${orphans === 1 ? "is" : "are"} not in any other playlist will also be removed from your bookmarks.`
            : "");
    if (!window.confirm(message)) return false;
    await STORE.deletePlaylist(playlist.id);
    return true;
};

// ---- Video cards (bookmarked videos list and playlist page)

const videoCard = (video, data, { onDelete, deleteLabel }) => {
    const item = element("li", "card video-card");
    const url = watchUrl(video.id, video.time);

    const body = element("div", "card-body");
    body.appendChild(externalLink("card-title", url, video.title || video.id));
    if (video.channel) {
        body.appendChild(element("div", "card-channel", video.channel));
    }
    // Keep it short: "00:01:05 · Nov 1, 2026" (time omitted when saved at the start)
    const metaParts = [video.time > 0 ? formatTime(video.time) : null, formatDate(video.savedAt)].filter(Boolean);
    body.appendChild(element("div", "card-meta", metaParts.join(" · ")));

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
    const shown = ui.videosView === "recent" ? newestFirst.slice(0, RECENT_LIMIT) : newestFirst;

    const list = element("ul", "cards");
    for (const video of shown) {
        list.appendChild(
            videoCard(video, data, {
                // Removes the bookmark and takes the video out of every playlist
                onDelete: () => STORE.removeVideo(video.id),
            })
        );
    }
    column.appendChild(list);

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

        if (ui.playlistForm?.mode === "rename" && ui.playlistForm.id === playlist.id) {
            row.classList.add("editing");
            row.appendChild(playlistNameForm("Save", (name) => STORE.renamePlaylist(playlist.id, name)));
            list.appendChild(row);
            continue;
        }

        const info = element("div", "playlist-info");
        const name = element("a", "playlist-name", playlist.name);
        name.href = playlistUrl(playlist.id);
        info.append(name, element("span", "playlist-count", pluralize(playlist.videoIds.length, "video")));

        const rename = iconButton("icon-action rename-btn", `Rename ${playlist.name}`, EDIT_ICON, () =>
            openPlaylistForm({ mode: "rename", id: playlist.id, value: playlist.name })
        );
        const remove = iconButton("icon-action danger delete-playlist-btn", `Delete ${playlist.name}`, TRASH_ICON, () =>
            confirmDeletePlaylist(playlist, data.library)
        );

        row.append(playlistThumb(playlist), info, rename, remove);
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
    if (ui.playlistForm?.mode === "rename" && ui.playlistForm.id === playlist.id) {
        header.appendChild(playlistNameForm("Save", (name) => STORE.renamePlaylist(playlist.id, name)));
    } else {
        const titles = element("div", "playlist-heading");
        titles.append(
            element("h2", "playlist-title", playlist.name),
            element("span", "playlist-count", pluralize(playlist.videoIds.length, "video"))
        );
        header.append(
            titles,
            iconButton("icon-action rename-btn", `Rename ${playlist.name}`, EDIT_ICON, () =>
                openPlaylistForm({ mode: "rename", id: playlist.id, value: playlist.name })
            ),
            iconButton("icon-action danger delete-playlist-btn", `Delete ${playlist.name}`, TRASH_ICON, async () => {
                if (await confirmDeletePlaylist(playlist, data.library)) window.location.href = "videos.html";
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

    const list = element("ul", "cards");
    for (const video of videos) {
        list.appendChild(
            videoCard(video, data, {
                deleteLabel: "Remove from playlist",
                onDelete: () => STORE.removeVideoFromPlaylist(video.id, playlist.id),
            })
        );
    }
    panel.appendChild(list);
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

    for (const videoId of videoIds) {
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
