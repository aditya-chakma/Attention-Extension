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
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    const result = {};
                    for (const key of keyList) {
                        if (key in storageData) result[key] = storageData[key];
                    }
                    callback(result);
                }),
                set: vi.fn((items, callback) => {
                    Object.assign(storageData, items);
                    if (callback) callback();
                }),
            },
        },
        tabs: {
            onUpdated: {
                addListener: vi.fn((fn) => tabUpdatedListeners.push(fn)),
            },
            sendMessage: vi.fn(() => Promise.resolve()),
            query: vi.fn(() => Promise.resolve([])),
        },

        __storageData: storageData,
        __messageListeners: messageListeners,
        __tabUpdatedListeners: tabUpdatedListeners,

        /** Clears recorded calls and stored data but keeps registered listeners. */
        __reset() {
            for (const key of Object.keys(storageData)) delete storageData[key];
            for (const fn of [
                chrome.runtime.getURL,
                chrome.storage.sync.get,
                chrome.storage.sync.set,
                chrome.tabs.sendMessage,
                chrome.tabs.query,
            ]) {
                fn.mockClear();
            }
        },
    };

    return chrome;
}
