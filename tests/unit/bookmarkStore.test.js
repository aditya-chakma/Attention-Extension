import { describe, it, expect, beforeAll } from "vitest";

let STORE;

beforeAll(async () => {
    await import("../../bookmarkStore.js");
    STORE = globalThis.ATTENTION_STORE;
});

const VIDEOS_KEY = "attention_bookmarked_videos";
const PLAYLISTS_KEY = "attention_playlists";

const video = (id, extra = {}) => ({ id, title: "Title " + id, channel: "", time: 0, savedAt: 1, ...extra });
const storedVideos = () => JSON.parse(chrome.__storageData[VIDEOS_KEY]);
const storedPlaylists = () => JSON.parse(chrome.__storageData[PLAYLISTS_KEY]);
const seed = ({ videos = [], playlists }) => {
    chrome.__storageData[VIDEOS_KEY] = JSON.stringify(videos);
    if (playlists) chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify(playlists);
};

describe("default playlists", () => {
    it("provides Favorites and Watch Later when playlists were never saved", async () => {
        const { playlists, videos } = await STORE.loadLibrary();

        expect(playlists).toEqual([
            { id: "favorites", name: "Favorites", videoIds: [] },
            { id: "watch-later", name: "Watch Later", videoIds: [] },
        ]);
        expect(videos).toEqual([]);
        // Reading does not write
        expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("persists the defaults with the first change", async () => {
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        expect(storedPlaylists().map((p) => p.name)).toEqual(["Favorites", "Watch Later"]);
    });

    it("does not bring the defaults back after the user deleted every playlist", async () => {
        await STORE.deletePlaylist("favorites");
        await STORE.deletePlaylist("watch-later");

        expect((await STORE.loadLibrary()).playlists).toEqual([]);
    });

    it("keeps bookmarks made before playlists existed", async () => {
        seed({ videos: [video("legacy")] });

        const { videos, playlists } = await STORE.loadLibrary();

        expect(videos.map((v) => v.id)).toEqual(["legacy"]);
        expect(playlists).toHaveLength(2);
    });

    it("treats corrupt stored values as empty", async () => {
        chrome.__storageData[VIDEOS_KEY] = "{not json";
        chrome.__storageData[PLAYLISTS_KEY] = JSON.stringify({ not: "a list" });

        expect(await STORE.loadLibrary()).toEqual({ videos: [], playlists: [] });
    });
});

describe("creating and renaming playlists", () => {
    it("creates a playlist with a trimmed name and a unique id", async () => {
        const a = await STORE.createPlaylist("  Deep   work ");
        const b = await STORE.createPlaylist("Music");

        expect(a.name).toBe("Deep work");
        expect(a.id).not.toBe(b.id);
        expect(storedPlaylists().map((p) => p.name)).toEqual(["Favorites", "Watch Later", "Deep work", "Music"]);
    });

    it("can save a video to the new playlist in the same write", async () => {
        const playlist = await STORE.createPlaylist("Talks", video("t1"));

        expect(chrome.storage.sync.set).toHaveBeenCalledTimes(1);
        expect(storedPlaylists().find((p) => p.id === playlist.id).videoIds).toEqual(["t1"]);
        expect(storedVideos().map((v) => v.id)).toEqual(["t1"]);
    });

    it.each([
        ["", "Enter a playlist name"],
        ["   ", "Enter a playlist name"],
        ["x".repeat(61), "Use at most 60 characters"],
        ["FAVORITES", 'A playlist named "FAVORITES" already exists'],
    ])("rejects the name %j", async (name, message) => {
        await expect(STORE.createPlaylist(name)).rejects.toThrow(message);
        expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("renames a playlist, allowing a change of case of its own name", async () => {
        await STORE.renamePlaylist("watch-later", "watch later");
        expect(storedPlaylists().find((p) => p.id === "watch-later").name).toBe("watch later");

        await STORE.renamePlaylist("watch-later", "Queue");
        expect(storedPlaylists().find((p) => p.id === "watch-later").name).toBe("Queue");
    });

    it("rejects renaming to another playlist's name or to nothing", async () => {
        await expect(STORE.renamePlaylist("watch-later", "favorites")).rejects.toThrow("already exists");
        await expect(STORE.renamePlaylist("watch-later", " ")).rejects.toThrow("Enter a playlist name");
    });

    it("reports a playlist that no longer exists", async () => {
        await expect(STORE.renamePlaylist("gone", "X")).rejects.toThrow("That playlist no longer exists");
        await expect(STORE.addVideoToPlaylist(video("a"), "gone")).rejects.toThrow("no longer exists");
    });
});

describe("saving videos to playlists", () => {
    it("bookmarks the video when it is first saved and keeps a single entry", async () => {
        await STORE.addVideoToPlaylist(video("a", { time: 5 }), "favorites");
        await STORE.addVideoToPlaylist(video("a", { time: 99 }), "watch-later");
        await STORE.addVideoToPlaylist(video("a"), "favorites"); // already there: no-op

        expect(storedVideos()).toEqual([video("a", { time: 5 })]); // first save's details are kept
        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([["a"], ["a"]]);
    });

    it("removing from one playlist keeps the bookmark while it is in another", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        const result = await STORE.removeVideoFromPlaylist("a", "favorites");

        expect(result).toEqual({ removedBookmark: false });
        expect(storedVideos().map((v) => v.id)).toEqual(["a"]);
    });

    it("removing from the last playlist removes the bookmark", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("b"), "favorites");

        const result = await STORE.removeVideoFromPlaylist("a", "favorites");

        expect(result).toEqual({ removedBookmark: true });
        expect(storedVideos().map((v) => v.id)).toEqual(["b"]);
    });

    it("removeVideo drops the bookmark and takes it out of every playlist", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "watch-later");
        await STORE.addVideoToPlaylist(video("b"), "watch-later");

        await STORE.removeVideo("a");

        expect(storedVideos().map((v) => v.id)).toEqual(["b"]);
        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([[], ["b"]]);
    });

    it("runs changes from one page one at a time so none are lost", async () => {
        await Promise.all([
            STORE.addVideoToPlaylist(video("a"), "favorites"),
            STORE.addVideoToPlaylist(video("b"), "favorites"),
            STORE.addVideoToPlaylist(video("c"), "watch-later"),
        ]);

        expect(storedVideos().map((v) => v.id)).toEqual(["a", "b", "c"]);
        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([["a", "b"], ["c"]]);
    });

    it("a failed change does not block the ones after it", async () => {
        const failed = STORE.addVideoToPlaylist(video("a"), "gone");
        const ok = STORE.addVideoToPlaylist(video("b"), "favorites");

        await expect(failed).rejects.toThrow();
        await ok;
        expect(storedVideos().map((v) => v.id)).toEqual(["b"]);
    });
});

describe("deleting a playlist", () => {
    it("removes videos that were only in that playlist and keeps the ones in another", async () => {
        seed({
            videos: [video("only"), video("shared"), video("elsewhere"), video("legacy")],
            playlists: [
                { id: "p1", name: "One", videoIds: ["only", "shared"] },
                { id: "p2", name: "Two", videoIds: ["shared", "elsewhere"] },
            ],
        });

        expect(STORE.videosOnlyIn(await STORE.loadLibrary(), "p1")).toEqual(["only"]);
        const result = await STORE.deletePlaylist("p1");

        expect(result).toEqual({ removedVideoIds: ["only"] });
        expect(storedPlaylists()).toEqual([{ id: "p2", name: "Two", videoIds: ["shared", "elsewhere"] }]);
        // "legacy" was bookmarked before playlists and is not touched
        expect(storedVideos().map((v) => v.id)).toEqual(["shared", "elsewhere", "legacy"]);
    });

    it("works for the default playlists too", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");

        await STORE.deletePlaylist("favorites");

        expect(storedPlaylists().map((p) => p.id)).toEqual(["watch-later"]);
        expect(storedVideos()).toEqual([]);
    });

    it("playlistsContaining lists every playlist a video is in", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        const library = await STORE.loadLibrary();
        expect(STORE.playlistsContaining(library, "a").map((p) => p.id)).toEqual(["favorites", "watch-later"]);
        expect(STORE.playlistsContaining(library, "zzz")).toEqual([]);
    });
});
