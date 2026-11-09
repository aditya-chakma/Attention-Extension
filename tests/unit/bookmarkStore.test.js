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
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("persists the defaults with the first change", async () => {
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        expect(storedPlaylists().map((p) => p.name)).toEqual(["Favorites", "Watch Later"]);
    });

    it("Favorites and Watch Later cannot be deleted", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");

        await expect(STORE.deletePlaylist("favorites")).rejects.toThrow('"Favorites" can\'t be deleted');
        await expect(STORE.deletePlaylist("watch-later")).rejects.toThrow('"Watch Later" can\'t be deleted');

        expect(storedPlaylists().map((p) => p.id)).toEqual(["favorites", "watch-later"]);
        expect(storedVideos().map((v) => v.id)).toEqual(["a"]);
        expect(STORE.isProtected("favorites")).toBe(true);
        expect(STORE.isProtected("watch-later")).toBe(true);
        expect(STORE.isProtected("pl-anything")).toBe(false);
    });

    it("Favorites and Watch Later cannot be renamed", async () => {
        await expect(STORE.renamePlaylist("favorites", "Best")).rejects.toThrow('"Favorites" can\'t be renamed');
        await expect(STORE.renamePlaylist("watch-later", "Queue")).rejects.toThrow('"Watch Later" can\'t be renamed');
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("but videos can still be added to and removed from them", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "watch-later");
        await STORE.removeVideoFromPlaylist("a", "favorites");

        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([[], ["a"]]);
    });

    it("restores the fixed names of defaults renamed by an older version", async () => {
        seed({
            playlists: [
                { id: "favorites", name: "Best", videoIds: ["a"] },
                { id: "watch-later", name: "Queue", videoIds: [] },
            ],
        });

        const { playlists } = await STORE.loadLibrary();

        expect(playlists).toEqual([
            { id: "favorites", name: "Favorites", videoIds: ["a"] },
            { id: "watch-later", name: "Watch Later", videoIds: [] },
        ]);
    });

    it("renames a custom playlist that took a default's name while the default was renamed", async () => {
        seed({
            playlists: [
                { id: "favorites", name: "Best", videoIds: [] },
                { id: "watch-later", name: "Watch Later", videoIds: [] },
                { id: "p1", name: "favorites", videoIds: [] },
            ],
        });

        const { playlists } = await STORE.loadLibrary();

        expect(playlists.map((p) => p.name)).toEqual(["Favorites", "Watch Later", "favorites (custom)"]);
    });

    it("restores a default deleted by an older version, at its usual position", async () => {
        seed({ playlists: [{ id: "favorites", name: "Favorites", videoIds: [] }, { id: "p1", name: "Mine", videoIds: [] }] });

        const { playlists } = await STORE.loadLibrary();

        expect(playlists.map((p) => p.id)).toEqual(["favorites", "watch-later", "p1"]);
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

        const { videos, playlists } = await STORE.loadLibrary();
        expect(videos).toEqual([]);
        expect(playlists.map((p) => p.id)).toEqual(["favorites", "watch-later"]);
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

        expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
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
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("renames a custom playlist, allowing a change of case of its own name", async () => {
        const { id } = await STORE.createPlaylist("Music");
        await STORE.renamePlaylist(id, "music");
        expect(storedPlaylists().find((p) => p.id === id).name).toBe("music");

        await STORE.renamePlaylist(id, "Queue");
        expect(storedPlaylists().find((p) => p.id === id).name).toBe("Queue");
    });

    it("rejects renaming to another playlist's name or to nothing", async () => {
        const { id } = await STORE.createPlaylist("Music");
        await expect(STORE.renamePlaylist(id, "favorites")).rejects.toThrow("already exists");
        await expect(STORE.renamePlaylist(id, " ")).rejects.toThrow("Enter a playlist name");
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

        expect(result.removedBookmark).toBe(false);
        expect(storedVideos().map((v) => v.id)).toEqual(["a"]);
    });

    it("removing from the last playlist removes the bookmark", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("b"), "favorites");

        const result = await STORE.removeVideoFromPlaylist("a", "favorites");

        expect(result.removedBookmark).toBe(true);
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
        expect(storedPlaylists().find((p) => p.id === "p1")).toBeUndefined();
        expect(storedPlaylists().find((p) => p.id === "p2")).toEqual({ id: "p2", name: "Two", videoIds: ["shared", "elsewhere"] });
        // "legacy" was bookmarked before playlists and is not touched
        expect(storedVideos().map((v) => v.id)).toEqual(["shared", "elsewhere", "legacy"]);
    });

    it("counts the default playlists as 'another playlist' when deleting a custom one", async () => {
        const custom = await STORE.createPlaylist("Custom");
        await STORE.addVideoToPlaylist(video("a"), custom.id);
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        await STORE.deletePlaylist(custom.id);

        expect(storedVideos().map((v) => v.id)).toEqual(["a"]);
        expect(storedPlaylists().map((p) => p.id)).toEqual(["favorites", "watch-later"]);
    });

    it("playlistsContaining lists every playlist a video is in", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        const library = await STORE.loadLibrary();
        expect(STORE.playlistsContaining(library, "a").map((p) => p.id)).toEqual(["favorites", "watch-later"]);
        expect(STORE.playlistsContaining(library, "zzz")).toEqual([]);
    });
});

describe("cleaning video titles", () => {
    it.each([
        ["(1) Big Buck Bunny", "Big Buck Bunny"],
        ["(12) Big Buck Bunny", "Big Buck Bunny"],
        ["(99+) Big Buck Bunny", "Big Buck Bunny"],
        ["(2024) Year in review", "(2024) Year in review"],
        ["Big Buck Bunny (1)", "Big Buck Bunny (1)"],
        [undefined, ""],
    ])("cleanTitle(%j) is %j", (input, expected) => {
        expect(STORE.cleanTitle(input)).toBe(expected);
    });

    it("strips the notification count from titles saved by earlier versions", async () => {
        seed({ videos: [video("a", { title: "(3) Some talk" })] });

        expect((await STORE.loadLibrary()).videos[0].title).toBe("Some talk");
    });
});

describe("undoing a removal", () => {
    it("restoreVideo puts a removed video back in its bookmark slot and in every playlist at its position", async () => {
        const custom = await STORE.createPlaylist("Custom");
        await STORE.addVideoToPlaylist(video("x"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("y"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), custom.id);
        const before = { videos: storedVideos(), playlists: storedPlaylists() };

        const snapshot = await STORE.removeVideo("a");
        expect(storedVideos().map((v) => v.id)).toEqual(["x", "y"]);

        await STORE.restoreVideo(snapshot);

        expect(storedVideos()).toEqual(before.videos);
        expect(storedPlaylists()).toEqual(before.playlists);
    });

    it("undoes removing a video from one playlist, including its dropped bookmark", async () => {
        await STORE.addVideoToPlaylist(video("a"), "watch-later");
        await STORE.addVideoToPlaylist(video("b"), "watch-later");

        const { removedBookmark, snapshot } = await STORE.removeVideoFromPlaylist("a", "watch-later");
        expect(removedBookmark).toBe(true);

        await STORE.restoreVideo(snapshot);

        expect(storedVideos().map((v) => v.id)).toEqual(["a", "b"]);
        expect(storedPlaylists().find((p) => p.id === "watch-later").videoIds).toEqual(["a", "b"]);
    });

    it("only restores the playlist it was removed from when it is still in others", async () => {
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        await STORE.addVideoToPlaylist(video("a"), "watch-later");

        const { snapshot } = await STORE.removeVideoFromPlaylist("a", "favorites");
        await STORE.restoreVideo(snapshot);

        expect(storedVideos().map((v) => v.id)).toEqual(["a"]);
        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([["a"], ["a"]]);
    });

    it("skips playlists deleted in the meantime and never duplicates", async () => {
        const custom = await STORE.createPlaylist("Custom");
        await STORE.addVideoToPlaylist(video("a"), custom.id);
        await STORE.addVideoToPlaylist(video("a"), "favorites");
        const snapshot = await STORE.removeVideo("a");

        await STORE.deletePlaylist(custom.id);
        await STORE.addVideoToPlaylist(video("a"), "favorites"); // re-saved before undo
        await STORE.restoreVideo(snapshot);

        expect(storedVideos().map((v) => v.id)).toEqual(["a"]);
        expect(storedPlaylists().map((p) => p.videoIds)).toEqual([["a"], []]);
    });
});
