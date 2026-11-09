import { vi } from "vitest";

/**
 * Minimal in-memory mock of the chrome.* APIs used by the extension.
 * Listeners registered via addListener are kept in __messageListeners /
 * __tabUpdatedListeners / __installedListeners so tests can invoke them directly.
 *
 * Both storage areas are modeled. Bookmarks live in `local` (exposed as
 * __storageData, which most tests seed and inspect); settings live in `sync`
 * (exposed as __syncData). Like Chrome, get/set/remove accept a callback or,
 * without one, return a Promise.
 */
export function createChromeMock() {
    const messageListeners = [];
    const tabUpdatedListeners = [];
    const installedListeners = [];
    const storageChangedListeners = [];

    const createArea = (areaName, data) => ({
        get: vi.fn((keys, callback) => {
            let result;
            if (keys === null || keys === undefined) {
                result = { ...data };
            } else {
                const keyList = Array.isArray(keys) ? keys : [keys];
                result = {};
                for (const key of keyList) {
                    if (key in data) result[key] = data[key];
                }
            }
            if (callback) callback(result);
            return Promise.resolve(result);
        }),
        set: vi.fn((items, callback) => {
            const changes = {};
            for (const [key, value] of Object.entries(items)) {
                changes[key] = { oldValue: data[key], newValue: value };
                data[key] = value;
            }
            if (callback) callback();
            // Like Chrome, notify every context (including the writer) of the change
            for (const fn of storageChangedListeners) fn(changes, areaName);
            return Promise.resolve();
        }),
        remove: vi.fn((keys, callback) => {
            const changes = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (!(key in data)) continue;
                changes[key] = { oldValue: data[key] };
                delete data[key];
            }
            if (callback) callback();
            if (Object.keys(changes).length > 0) {
                for (const fn of storageChangedListeners) fn(changes, areaName);
            }
            return Promise.resolve();
        }),
    });

    const localData = {};
    const syncData = {};

    const chrome = {
        runtime: {
            getURL: vi.fn((path) => `chrome-extension://test-extension-id/${path}`),
            onMessage: {
                addListener: vi.fn((fn) => messageListeners.push(fn)),
            },
            onInstalled: {
                addListener: vi.fn((fn) => installedListeners.push(fn)),
            },
        },
        storage: {
            local: createArea("local", localData),
            sync: createArea("sync", syncData),
            onChanged: {
                addListener: vi.fn((fn) => storageChangedListeners.push(fn)),
            },
        },
        tabs: {
            onUpdated: {
                addListener: vi.fn((fn) => tabUpdatedListeners.push(fn)),
            },
            sendMessage: vi.fn(() => Promise.resolve()),
            query: vi.fn(() => Promise.resolve([])),
            create: vi.fn(() => Promise.resolve({})),
        },

        __storageData: localData,
        __syncData: syncData,
        __messageListeners: messageListeners,
        __tabUpdatedListeners: tabUpdatedListeners,
        __installedListeners: installedListeners,
        __storageChangedListeners: storageChangedListeners,

        /** Clears recorded calls and stored data but keeps registered listeners. */
        __reset() {
            for (const key of Object.keys(localData)) delete localData[key];
            for (const key of Object.keys(syncData)) delete syncData[key];
            for (const fn of [
                chrome.runtime.getURL,
                ...Object.values(chrome.storage.local),
                ...Object.values(chrome.storage.sync),
                chrome.tabs.sendMessage,
                chrome.tabs.query,
                chrome.tabs.create,
            ]) {
                fn.mockClear();
            }
        },
    };

    return chrome;
}
