import { vi } from "vitest";

/**
 * Minimal in-memory mock of the chrome.* APIs used by the extension.
 * Listeners registered via addListener are kept in __messageListeners /
 * __tabUpdatedListeners so tests can invoke them directly.
 */
export function createChromeMock() {
    const storageData = {};
    const messageListeners = [];
    const tabUpdatedListeners = [];
    const storageChangedListeners = [];

    const chrome = {
        runtime: {
            getURL: vi.fn((path) => `chrome-extension://test-extension-id/${path}`),
            onMessage: {
                addListener: vi.fn((fn) => messageListeners.push(fn)),
            },
        },
        storage: {
            sync: {
                get: vi.fn((keys, callback) => {
                    if (keys === null || keys === undefined) {
                        callback({ ...storageData });
                        return;
                    }
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    const result = {};
                    for (const key of keyList) {
                        if (key in storageData) result[key] = storageData[key];
                    }
                    callback(result);
                }),
                set: vi.fn((items, callback) => {
                    const changes = {};
                    for (const [key, value] of Object.entries(items)) {
                        changes[key] = { oldValue: storageData[key], newValue: value };
                        storageData[key] = value;
                    }
                    if (callback) callback();
                    // Like Chrome, notify every context (including the writer) of the change
                    for (const fn of storageChangedListeners) fn(changes, "sync");
                }),
            },
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

        __storageData: storageData,
        __messageListeners: messageListeners,
        __tabUpdatedListeners: tabUpdatedListeners,
        __storageChangedListeners: storageChangedListeners,

        /** Clears recorded calls and stored data but keeps registered listeners. */
        __reset() {
            for (const key of Object.keys(storageData)) delete storageData[key];
            for (const fn of [
                chrome.runtime.getURL,
                chrome.storage.sync.get,
                chrome.storage.sync.set,
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
