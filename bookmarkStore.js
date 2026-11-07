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
 *  - Favorites and Watch Later exist until the user deletes them; they are
 *    seeded whenever the playlists key has never been written.
 */
(() => {
    const VIDEOS_KEY = "attention_bookmarked_videos";
    const PLAYLISTS_KEY = "attention_playlists";
    const MAX_NAME_LENGTH = 60;

    const DEFAULT_PLAYLISTS = Object.freeze([
        Object.freeze({ id: "favorites", name: "Favorites" }),
        Object.freeze({ id: "watch-later", name: "Watch Later" }),
    ]);

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

    /** Reads { videos, playlists }, with the default playlists if none were ever saved. */
    const loadLibrary = async () => {
        const data = await getItems([VIDEOS_KEY, PLAYLISTS_KEY]);
        const playlists =
            PLAYLISTS_KEY in data
                ? parse(data[PLAYLISTS_KEY], [])
                : DEFAULT_PLAYLISTS.map((p) => ({ ...p, videoIds: [] }));
        return { videos: parse(data[VIDEOS_KEY], []), playlists };
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
            playlist.name = validateName(library, name, playlistId);
            return playlist;
        });

    /** Deletes a playlist and the bookmarks of videos that were only in it. */
    const deletePlaylist = (playlistId) =>
        mutate((library) => {
            const playlist = findPlaylist(library, playlistId);
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

    /** Removes a video from one playlist; un-bookmarks it if that was its last one. */
    const removeVideoFromPlaylist = (videoId, playlistId) =>
        mutate((library) => {
            const playlist = findPlaylist(library, playlistId);
            playlist.videoIds = playlist.videoIds.filter((id) => id !== videoId);
            return { removedBookmark: dropOrphans(library, [videoId]).length > 0 };
        });

    /** Removes a video's bookmark and takes it out of every playlist. */
    const removeVideo = (videoId) =>
        mutate((library) => {
            library.videos = library.videos.filter((v) => v.id !== videoId);
            for (const playlist of library.playlists) {
                playlist.videoIds = playlist.videoIds.filter((id) => id !== videoId);
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
        loadLibrary,
        createPlaylist,
        renamePlaylist,
        deletePlaylist,
        addVideoToPlaylist,
        removeVideoFromPlaylist,
        removeVideo,
        videosOnlyIn,
        playlistsContaining,
    });
})();
