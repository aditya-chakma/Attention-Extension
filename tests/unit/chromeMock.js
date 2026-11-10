import { vi } from "vitest";

/**
 * Minimal in-memory mock of the chrome.* APIs used by the extension.
 * Listeners registered via addListener are kept in __messageListeners /
 * __tabUpdatedListeners / __installedListeners / __startupListeners /
 * __alarmListeners so tests can invoke them directly. Dynamic
 * declarativeNetRequest rules are kept in __dynamicRules.
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
    const startupListeners = [];
    const alarmListeners = [];
    const storageChangedListeners = [];
    let dynamicRules = [];

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
            onStartup: {
                addListener: vi.fn((fn) => startupListeners.push(fn)),
            },
        },
        declarativeNetRequest: {
            getDynamicRules: vi.fn(() => Promise.resolve(dynamicRules.map((rule) => structuredClone(rule)))),
            updateDynamicRules: vi.fn(({ removeRuleIds = [], addRules = [] }) => {
                dynamicRules = dynamicRules.filter((rule) => !removeRuleIds.includes(rule.id));
                for (const rule of addRules) {
                    if (dynamicRules.some((r) => r.id === rule.id)) {
                        return Promise.reject(new Error(`Rule with id ${rule.id} does not have a unique ID.`));
                    }
                    dynamicRules.push(structuredClone(rule));
                }
                return Promise.resolve();
            }),
        },
        alarms: {
            create: vi.fn(() => Promise.resolve()),
            clear: vi.fn(() => Promise.resolve(true)),
            onAlarm: {
                addListener: vi.fn((fn) => alarmListeners.push(fn)),
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
            update: vi.fn(() => Promise.resolve({})),
        },

        __storageData: localData,
        __syncData: syncData,
        __messageListeners: messageListeners,
        __tabUpdatedListeners: tabUpdatedListeners,
        __installedListeners: installedListeners,
        __startupListeners: startupListeners,
        __alarmListeners: alarmListeners,
        __storageChangedListeners: storageChangedListeners,
        get __dynamicRules() {
            return dynamicRules;
        },

        /** Clears recorded calls and stored data but keeps registered listeners. */
        __reset() {
            for (const key of Object.keys(localData)) delete localData[key];
            for (const key of Object.keys(syncData)) delete syncData[key];
            dynamicRules = [];
            for (const fn of [
                chrome.runtime.getURL,
                ...Object.values(chrome.storage.local),
                ...Object.values(chrome.storage.sync),
                ...Object.values(chrome.declarativeNetRequest),
                chrome.alarms.create,
                chrome.alarms.clear,
                chrome.tabs.sendMessage,
                chrome.tabs.query,
                chrome.tabs.create,
                chrome.tabs.update,
            ]) {
                fn.mockClear();
            }
            chrome.tabs.query.mockImplementation(() => Promise.resolve([]));
        },
    };

    return chrome;
}
