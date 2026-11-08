/**
 * Bookmarked videos and playlists, shared by the content script (player
 * "Save to playlist" panel) and the dashboard pages.
 *
 * Loaded two ways, like icons.js: as a content script before contentScript.js
 * (see manifest.json) and via `import "./bookmarkStore.js"` from extension
 * pages. Publishes globalThis.ATTENTION_STORE.
 *
 * Storage (chrome.storage.sync, JSON strings):
 *  - attention_bookmarked_videos: [{ id, title, channel, time, savedAt }]
 *    details of every bookmarked video
 *  - attention_playlists: [{ id, name, videoIds: [videoId, ...] }]
 *    videoIds are in the order they were added
 *
 * Rules:
 *  - A video can be in any number of playlists.
 *  - Saving a video to a playlist bookmarks it; when it leaves its last
 *    playlist (removed from it, or the playlist is deleted) the bookmark goes too.
 *  - Favorites and Watch Later always exist and are fixed: they can't be
 *    renamed or deleted (videos can still be added to and removed from them).
 *    A missing or renamed default is restored on load.
 */
(() => {
    const VIDEOS_KEY = "attention_bookmarked_videos";
    const PLAYLISTS_KEY = "attention_playlists";
    const MAX_NAME_LENGTH = 60;

    const DEFAULT_PLAYLISTS = Object.freeze([
        Object.freeze({ id: "favorites", name: "Favorites" }),
        Object.freeze({ id: "watch-later", name: "Watch Later" }),
    ]);

    const PROTECTED_PLAYLIST_IDS = Object.freeze(DEFAULT_PLAYLISTS.map((p) => p.id));
    const isProtected = (playlistId) => PROTECTED_PLAYLIST_IDS.includes(playlistId);

    // YouTube prefixes the tab title with the unread-notification count, e.g.
    // "(3) Video name". Titles were captured from the tab title, so strip it.
    // 1-2 digits (or "99+") only, so titles like "(2024) Recap" are kept.
    const cleanTitle = (title) => String(title ?? "").replace(/^\(\d{1,2}\+?\)\s+/, "");

    const getItems = (keys) => new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
    const setItems = (items) => new Promise((resolve) => chrome.storage.sync.set(items, resolve));

    const parse = (raw, fallback) => {
        if (!raw) return fallback;
        try {
            const value = JSON.parse(raw);
            return Array.isArray(value) ? value : fallback;
        } catch {
            return fallback;
        }
    };

    /** Reads { videos, playlists }; the default playlists are always present with their fixed names. */
    const loadLibrary = async () => {
        const data = await getItems([VIDEOS_KEY, PLAYLISTS_KEY]);
        const playlists = parse(data[PLAYLISTS_KEY], []);
        DEFAULT_PLAYLISTS.forEach((defaults, index) => {
            const existing = playlists.find((p) => p.id === defaults.id);
            if (existing) {
                // Older versions allowed renaming the defaults
                existing.name = defaults.name;
            } else {
                // Never saved yet, or deleted by an older version: put it back in its usual place
                playlists.splice(Math.min(index, playlists.length), 0, { ...defaults, videoIds: [] });
            }
        });
        // A custom playlist may have taken a default's name while it was renamed
        for (const playlist of playlists) {
            const clash = DEFAULT_PLAYLISTS.find(
                (d) => d.id !== playlist.id && d.name.toLowerCase() === playlist.name.toLowerCase()
            );
            if (clash) playlist.name = playlist.name + " (custom)";
        }
        const videos = parse(data[VIDEOS_KEY], []).map((v) => ({ ...v, title: cleanTitle(v.title) }));
        return { videos, playlists };
    };

    // Mutations from one page/tab run one at a time, so two quick clicks can't
    // both read the same state and overwrite each other. Both keys are written
    // in a single set() call so they never disagree.
    let queue = Promise.resolve();
    const mutate = (change) => {
        const run = queue.then(async () => {
            const library = await loadLibrary();
            const result = change(library);
            await setItems({
                [VIDEOS_KEY]: JSON.stringify(library.videos),
                [PLAYLISTS_KEY]: JSON.stringify(library.playlists),
            });
            return result;
        });
        queue = run.catch(() => {});
        return run;
    };

    const findPlaylist = (library, playlistId) => {
        const playlist = library.playlists.find((p) => p.id === playlistId);
        if (!playlist) throw new Error("That playlist no longer exists");
        return playlist;
    };

    const isInAnyPlaylist = (library, videoId) => library.playlists.some((p) => p.videoIds.includes(videoId));

    /** Trims and validates a playlist name; throws an Error with a user-facing message. */
    const validateName = (library, rawName, ignoreId = null) => {
        const name = String(rawName ?? "").replace(/\s+/g, " ").trim();
        if (!name) throw new Error("Enter a playlist name");
        if (name.length > MAX_NAME_LENGTH) throw new Error(`Use at most ${MAX_NAME_LENGTH} characters`);
        const taken = library.playlists.some((p) => p.id !== ignoreId && p.name.toLowerCase() === name.toLowerCase());
        if (taken) throw new Error(`A playlist named "${name}" already exists`);
        return name;
    };

    const newPlaylistId = () => "pl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

    const addToPlaylist = (library, video, playlist) => {
        if (!library.videos.some((v) => v.id === video.id)) library.videos.push(video);
        if (!playlist.videoIds.includes(video.id)) playlist.videoIds.push(video.id);
    };

    /** Removes bookmarks of the given videos that are no longer in any playlist. */
    const dropOrphans = (library, videoIds) => {
        const orphans = videoIds.filter((id) => !isInAnyPlaylist(library, id));
        library.videos = library.videos.filter((v) => !orphans.includes(v.id));
        return orphans;
    };

    /** Creates a playlist, optionally saving `video` to it in the same write. */
    const createPlaylist = (name, video = null) =>
        mutate((library) => {
            const playlist = { id: newPlaylistId(), name: validateName(library, name), videoIds: [] };
            library.playlists.push(playlist);
            if (video) addToPlaylist(library, video, playlist);
            return playlist;
        });

    const renamePlaylist = (playlistId, name) =>
        mutate((library) => {
            const playlist = findPlaylist(library, playlistId);
            if (isProtected(playlistId)) throw new Error(`"${playlist.name}" can't be renamed`);
            playlist.name = validateName(library, name, playlistId);
            return playlist;
        });

    /** Deletes a playlist and the bookmarks of videos that were only in it. */
    const deletePlaylist = (playlistId) =>
        mutate((library) => {
            const playlist = findPlaylist(library, playlistId);
            if (isProtected(playlistId)) throw new Error(`"${playlist.name}" can't be deleted`);
            library.playlists = library.playlists.filter((p) => p !== playlist);
            return { removedVideoIds: dropOrphans(library, playlist.videoIds) };
        });

    /** Saves a video ({ id, title, channel, time, savedAt }) to a playlist. */
    const addVideoToPlaylist = (video, playlistId) =>
        mutate((library) => {
            const playlist = findPlaylist(library, playlistId);
            addToPlaylist(library, video, playlist);
            return playlist;
        });

    /**
     * Records where a video is before removing it, so restoreVideo() can put
     * it back exactly: its bookmark entry and its position in each playlist.
     */
    const snapshotVideo = (library, videoId, playlistIds) => ({
        videoId,
        video: library.videos.find((v) => v.id === videoId) || null,
        videoIndex: library.videos.findIndex((v) => v.id === videoId),
        memberships: library.playlists
            .filter((p) => playlistIds.includes(p.id) && p.videoIds.includes(videoId))
            .map((p) => ({ playlistId: p.id, index: p.videoIds.indexOf(videoId) })),
    });

    /** Removes a video from one playlist; un-bookmarks it if that was its last one. */
    const removeVideoFromPlaylist = (videoId, playlistId) =>
        mutate((library) => {
            const playlist = findPlaylist(library, playlistId);
            const snapshot = snapshotVideo(library, videoId, [playlistId]);
            playlist.videoIds = playlist.videoIds.filter((id) => id !== videoId);
            const removedBookmark = dropOrphans(library, [videoId]).length > 0;
            return { removedBookmark, snapshot };
        });

    /** Removes a video's bookmark and takes it out of every playlist. Returns an undo snapshot. */
    const removeVideo = (videoId) =>
        mutate((library) => {
            const snapshot = snapshotVideo(library, videoId, library.playlists.map((p) => p.id));
            library.videos = library.videos.filter((v) => v.id !== videoId);
            for (const playlist of library.playlists) {
                playlist.videoIds = playlist.videoIds.filter((id) => id !== videoId);
            }
            return snapshot;
        });

    /**
     * Undoes removeVideo / removeVideoFromPlaylist from their snapshot. Playlists
     * deleted in the meantime are skipped; nothing is duplicated if the video
     * was re-added elsewhere in the meantime.
     */
    const restoreVideo = (snapshot) =>
        mutate((library) => {
            const { videoId, video, videoIndex, memberships } = snapshot;
            if (video && !library.videos.some((v) => v.id === video.id)) {
                const at = videoIndex >= 0 ? Math.min(videoIndex, library.videos.length) : library.videos.length;
                library.videos.splice(at, 0, video);
            }
            for (const { playlistId, index } of memberships) {
                const playlist = library.playlists.find((p) => p.id === playlistId);
                if (!playlist || playlist.videoIds.includes(videoId)) continue;
                playlist.videoIds.splice(Math.min(index, playlist.videoIds.length), 0, videoId);
            }
        });

    /** Videos that deleting this playlist would un-bookmark (pure; for confirmations). */
    const videosOnlyIn = (library, playlistId) => {
        const playlist = library.playlists.find((p) => p.id === playlistId);
        if (!playlist) return [];
        return playlist.videoIds.filter((id) => !library.playlists.some((p) => p !== playlist && p.videoIds.includes(id)));
    };

    /** Playlists that contain the video (pure). */
    const playlistsContaining = (library, videoId) => library.playlists.filter((p) => p.videoIds.includes(videoId));

    globalThis.ATTENTION_STORE = Object.freeze({
        VIDEOS_KEY,
        PLAYLISTS_KEY,
        MAX_NAME_LENGTH,
        DEFAULT_PLAYLISTS,
        PROTECTED_PLAYLIST_IDS,
        isProtected,
        cleanTitle,
        loadLibrary,
        createPlaylist,
        renamePlaylist,
        deletePlaylist,
        addVideoToPlaylist,
        removeVideoFromPlaylist,
        removeVideo,
        restoreVideo,
        videosOnlyIn,
        playlistsContaining,
    });
})();
