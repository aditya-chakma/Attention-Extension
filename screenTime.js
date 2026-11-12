/**
 * Screen time on the sites Attention cares about: YouTube, Facebook and every
 * site on the block list (time on those is spent during temporary unblocks
 * or outside their schedule). Imported by background.js, which owns the
 * chrome.* listeners; time is written with statsStore.js "screenTime" events.
 *
 * Time counts for the active tab of the last focused browser window while
 *  - the screen isn't locked, and
 *  - the browser window has focus and the user isn't idle, or the tab is
 *    playing sound. chrome.idle only sees keyboard and mouse input, so
 *    without the audible exception watching a video would stop counting
 *    after IDLE_DETECTION_SECONDS.
 *
 * Service workers are short-lived, so the interval being measured lives in
 * chrome.storage.session (cleared when the browser closes): { domain, start }.
 * Every checkpoint credits the time since `start` and starts a new interval
 * (or none). Checkpoints run on tab, window, idle and audio changes, and once
 * a minute from an alarm while something is being measured, so at most about
 * a minute is lost if the browser quits. A credit never exceeds
 * MAX_CREDIT_MS: a longer gap means the computer slept or the worker missed
 * events, and that time wasn't spent on the site.
 */

export const SESSION_KEY = "attention_screen_time_session";
export const SCREEN_TIME_ALARM = "attention-screen-time";
export const IDLE_DETECTION_SECONDS = 120;
export const HEARTBEAT_MINUTES = 1;
export const MAX_CREDIT_MS = 2 * 60 * 1000;
// Shorter intervals are kept open rather than written: rapid tab switching
// shouldn't cost a storage write per switch
export const MIN_CREDIT_MS = 1000;
export const ALWAYS_TRACKED = Object.freeze(["youtube.com", "facebook.com"]);

/**
 * The tracked domain a URL belongs to, or null. The most specific match wins
 * (a blocked music.youtube.com is counted apart from youtube.com).
 */
export const trackedDomainFor = (url, trackedDomains, domainMatches) => {
    if (typeof url !== "string" || !/^https?:/.test(url)) return null;
    let best = null;
    for (const domain of trackedDomains) {
        if (domainMatches(domain, url) && (!best || domain.length > best.length)) best = domain;
    }
    return best;
};

/** Where screen time is going right now (see the rules at the top), or null. */
export const decideDomain = ({ tab, windowFocused, idleState, trackedDomains, domainMatches }) => {
    if (!tab || idleState === "locked") return null;
    const engaged = Boolean(tab.audible) || (windowFocused && idleState === "active");
    if (!engaged) return null;
    return trackedDomainFor(tab.url, trackedDomains, domainMatches);
};

const parseSession = (raw) => {
    if (!raw) return null;
    try {
        const session = JSON.parse(raw);
        return session && typeof session.domain === "string" && Number.isFinite(session.start) ? session : null;
    } catch {
        return null;
    }
};

/**
 * `settings` and `stats` are globalThis.ATTENTION_SETTINGS / ATTENTION_STATS;
 * `now` is injectable for tests. Returns { checkpoint, register }.
 */
export function createScreenTimeTracker({ settings, stats, now = () => Date.now() }) {
    const readSession = async () => parseSession((await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]);
    const writeSession = (session) => chrome.storage.session.set({ [SESSION_KEY]: JSON.stringify(session) });

    const currentDomain = async () => {
        // populate: the active tab comes with the window, one call fewer
        const [idleState, win, sites] = await Promise.all([
            chrome.idle.queryState(IDLE_DETECTION_SECONDS),
            chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] }).catch(() => null),
            settings.loadBlockedSites(),
        ]);
        if (!win) return null;
        return decideDomain({
            tab: (win.tabs ?? []).find((t) => t.active),
            windowFocused: Boolean(win.focused),
            idleState,
            trackedDomains: [...new Set([...ALWAYS_TRACKED, ...sites.map((s) => s.domain)])],
            domainMatches: settings.domainMatches,
        });
    };

    const credit = async (domain, ms, nowMs) => {
        try {
            await stats.record({ event: "screenTime", domain, ms }, new Date(nowMs));
        } catch (error) {
            console.error("Attention: recording screen time failed", error);
        }
    };

    const run = async () => {
        const nowMs = now();
        const [session, domain] = await Promise.all([readSession(), currentDomain()]);

        if (session) {
            // A clock set backwards gives a negative interval: credit nothing
            const elapsed = Math.max(0, nowMs - session.start);
            // Same site, too short to write: keep the interval running
            if (domain === session.domain && elapsed < MIN_CREDIT_MS) return;
            if (elapsed >= MIN_CREDIT_MS) await credit(session.domain, Math.min(elapsed, MAX_CREDIT_MS), nowMs);
        }

        if (domain) {
            await writeSession({ domain, start: nowMs });
            if (!session) await chrome.alarms.create(SCREEN_TIME_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
        } else {
            if (session) await chrome.storage.session.remove(SESSION_KEY);
            // Also drops a heartbeat left over from a previous browser run
            await chrome.alarms.clear(SCREEN_TIME_ALARM);
        }
    };

    // Serialized and collapsed like syncRules() in background.js: events come
    // in bursts (a tab switch fires onActivated and onFocusChanged together)
    // and each run must see the session the previous one wrote
    let running = null;
    let again = false;
    const checkpoint = () => {
        if (running) {
            again = true;
            return running;
        }
        running = run()
            .catch((error) => console.error("Attention: screen time checkpoint failed", error))
            .finally(() => {
                running = null;
                if (again) {
                    again = false;
                    checkpoint();
                }
            });
        return running;
    };

    /**
     * Listens to the tab, window and idle events. Startup, install and the
     * heartbeat alarm are routed here by background.js, which owns those
     * listeners. Must be called synchronously while the worker starts.
     */
    const register = () => {
        chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
        chrome.tabs.onActivated.addListener(() => checkpoint());
        chrome.tabs.onRemoved.addListener(() => checkpoint());
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.url || "audible" in changeInfo) checkpoint();
        });
        chrome.windows.onFocusChanged.addListener(() => checkpoint());
        chrome.idle.onStateChanged.addListener(() => checkpoint());
    };

    return { checkpoint, register };
}
