// Shared by videos.html and timestamps.html. The page decides what to render
// through the data-page attribute on #content.

// Publishes the globalThis.ATTENTION_ICONS registry (shared with the content script)
import "./icons.js";

// Reserved storage keys. Every other key in chrome.storage.sync is a YouTube
// video id holding its timestamp bookmarks.
const VIDEOS_KEY = "attention_bookmarked_videos";
const TITLES_KEY = "attention_video_titles";
const RESERVED_KEYS = [VIDEOS_KEY, TITLES_KEY];

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

// YouTube serves thumbnails for any public video id at this URL; no API key needed
const thumbnailUrl = (videoId) => "https://i.ytimg.com/vi/" + encodeURIComponent(videoId) + "/mqdefault.jpg";

// All user-provided text (titles, channel names, descriptions) is set via
// textContent, never innerHTML, so it cannot inject markup into the page.
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

// Static SVG markup only (never user data), so innerHTML is safe here
const { trash: TRASH_ICON, play: PLAY_ICON } = globalThis.ATTENTION_ICONS.markup;

const formatDate = (timestamp) =>
    new Date(timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const thumbnail = (videoId, href, small = false) => {
    const link = externalLink(small ? "thumb thumb-small" : "thumb", href);
    const img = element("img");
    img.src = thumbnailUrl(videoId);
    img.alt = "";
    img.loading = "lazy";
    link.appendChild(img);
    return link;
};

const deleteButton = (onDelete) => {
    const button = element("button", "delete-btn");
    button.type = "button";
    button.title = "Delete";
    button.setAttribute("aria-label", "Delete");
    button.innerHTML = TRASH_ICON;
    button.addEventListener("click", onDelete);
    return button;
};

const loadBookmarks = async () => {
    const all = await fetchAllStorage();
    const videos = parseJSON(all[VIDEOS_KEY], []);
    const titles = parseJSON(all[TITLES_KEY], {});

    const timestamps = {};
    for (const [key, raw] of Object.entries(all)) {
        if (RESERVED_KEYS.includes(key)) continue;
        const value = parseJSON(raw, null);
        if (Array.isArray(value) && value.length > 0) {
            timestamps[key] = value;
        }
    }

    return { videos, titles, timestamps };
};

const titleForVideo = (videoId, { titles, videos }) => {
    const bookmarkedVideo = videos.find((v) => v.id === videoId);
    return titles[videoId] || (bookmarkedVideo && bookmarkedVideo.title) || videoId;
};

const renderVideos = (panel, data) => {
    panel.innerHTML = "";

    if (data.videos.length === 0) {
        panel.appendChild(
            element("p", "empty", "No bookmarked videos yet. Use the save button in the YouTube player to bookmark a video.")
        );
        return;
    }

    const list = element("ul", "cards");
    const newestFirst = [...data.videos].sort((a, b) => b.savedAt - a.savedAt);

    for (const video of newestFirst) {
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

        const deleteBtn = deleteButton(async () => {
            const current = parseJSON((await fetchAllStorage())[VIDEOS_KEY], []);
            // The storage.onChanged listener below re-renders the page
            await setStorage({ [VIDEOS_KEY]: JSON.stringify(current.filter((v) => v.id !== video.id)) });
        });

        item.append(thumbnail(video.id, url), body, deleteBtn);
        list.appendChild(item);
    }

    panel.appendChild(list);
};

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

const render = async () => {
    const content = document.getElementById("content");
    if (!content) return;

    const data = await loadBookmarks();
    if (content.dataset.page === "timestamps") {
        renderTimestamps(content, data);
    } else {
        renderVideos(content, data);
    }
};

document.addEventListener("DOMContentLoaded", render);

// Keep the page in sync with bookmarks added or removed anywhere (player
// buttons, popup, another dashboard tab) without a reload
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") render();
});
