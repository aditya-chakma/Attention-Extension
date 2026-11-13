/**
 * Usage statistics for the Insights page: Shorts/Reels removed and
 * redirected, blocked-site visits, temporary unblocks and screen time.
 *
 * Imported (`import "./statsStore.js"`) by the background service worker and
 * by the extension pages that read the numbers. Publishes
 * globalThis.ATTENTION_STATS.
 *
 * Only background.js writes. Content scripts and the blocked page report
 * events with chrome.runtime.sendMessage({ type: STATS_MESSAGE, event }); the
 * worker applies them one at a time, so several tabs counting at once can't
 * overwrite each other's increments.
 *
 * Storage (chrome.storage.local: statistics describe this device, and the
 * counters change far too often for the sync quota). Values are JSON strings,
 * like every other key:
 *  - attention_stats_day_<YYYY-MM-DD> (local date), one key per day:
 *      { shortsRemoved, reelsRemoved, shortsRedirects, reelsRedirects,
 *        blockedVisits: { "<domain>": count },
 *        unblocks: { "<domain>": { count, minutes } },
 *        screenTimeMs: { "<domain>": ms } }
 *    Days older than RETENTION_DAYS are deleted on the first write of a day.
 *  - attention_stats_meta: { trackingSince: "<YYYY-MM-DD>" }, the first day
 *    anything was recorded (the focus streak can't reach further back).
 */
(() => {
    const DAY_PREFIX = "attention_stats_day_";
    const META_KEY = "attention_stats_meta";
    const STATS_MESSAGE = "STATS_EVENT";

    // 180 days: the 90-day view can compare against the 90 days before it
    const RETENTION_DAYS = 180;

    // Sanity caps for reported values; a bug elsewhere shouldn't be able to
    // write absurd numbers that dwarf every chart
    const MAX_COUNT_PER_EVENT = 1000;
    const MAX_SCREEN_TIME_MS_PER_EVENT = 24 * 60 * 60 * 1000;
    const MAX_UNBLOCK_MINUTES = 24 * 60;

    // Rough minutes of scrolling each event is assumed to prevent. Shown on
    // the Insights page as an estimate, never as a measurement.
    const TIME_SAVED_MINUTES = Object.freeze({
        blockedVisit: 10,
        redirect: 5,
        removal: 1,
    });

    const KINDS = ["shorts", "reels"];

    // Events content scripts and pages may report. Unblocks and screen time
    // are only recorded by background.js itself.
    const MESSAGE_EVENTS = ["removal", "redirect", "blockedVisit"];

    const emptyDay = () => ({
        shortsRemoved: 0,
        reelsRemoved: 0,
        shortsRedirects: 0,
        reelsRedirects: 0,
        blockedVisits: {},
        unblocks: {},
        screenTimeMs: {},
    });

    const parse = (raw, fallback) => {
        if (!raw) return fallback;
        try {
            const value = JSON.parse(raw);
            return value && typeof value === "object" ? value : fallback;
        } catch {
            return fallback;
        }
    };

    const getLocal = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    const setLocal = (items) => new Promise((resolve) => chrome.storage.local.set(items, resolve));
    const removeLocal = (keys) => new Promise((resolve) => chrome.storage.local.remove(keys, resolve));

    // ---- Dates (local time) ------------------------------------------------

    const pad2 = (n) => String(n).padStart(2, "0");

    /** "YYYY-MM-DD" of the date in local time. */
    const dayKey = (date = new Date()) =>
        `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

    const storageKey = (day) => DAY_PREFIX + day;

    const DAY_KEY_PATTERN = new RegExp("^" + DAY_PREFIX + "(\\d{4}-\\d{2}-\\d{2})$");

    /** True for the storage keys this store owns (for storage.onChanged listeners). */
    const isStatsKey = (key) => key === META_KEY || DAY_KEY_PATTERN.test(key);

    /** The `count` day keys ending today, oldest first. Steps by calendar day, so DST is harmless. */
    const lastDays = (count, now = new Date()) => {
        const days = [];
        for (let offset = count - 1; offset >= 0; offset--) {
            const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
            days.push(dayKey(day));
        }
        return days;
    };

    // ---- Validation --------------------------------------------------------

    const fail = (message) => {
        throw new Error("Invalid stats event: " + message);
    };

    const positiveInteger = (value, max, name) => {
        if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
        return Math.min(value, max);
    };

    const validDomain = (domain) => {
        if (typeof domain !== "string" || !/^[a-z0-9.-]{1,253}$/.test(domain)) fail("bad domain");
        return domain;
    };

    const validKind = (kind) => {
        if (!KINDS.includes(kind)) fail(`kind must be one of ${KINDS.join(", ")}`);
        return kind;
    };

    /** Checks and normalizes an event; throws on anything malformed. */
    const validateEvent = (event) => {
        if (!event || typeof event !== "object") fail("not an object");
        switch (event.event) {
            case "removal":
                return {
                    event: "removal",
                    kind: validKind(event.kind),
                    count: positiveInteger(event.count, MAX_COUNT_PER_EVENT, "count"),
                };
            case "redirect":
                return { event: "redirect", kind: validKind(event.kind) };
            case "blockedVisit":
                return { event: "blockedVisit", domain: validDomain(event.domain) };
            case "unblock":
                return {
                    event: "unblock",
                    domain: validDomain(event.domain),
                    minutes: positiveInteger(event.minutes, MAX_UNBLOCK_MINUTES, "minutes"),
                };
            case "screenTime":
                return {
                    event: "screenTime",
                    domain: validDomain(event.domain),
                    ms: positiveInteger(Math.round(event.ms), MAX_SCREEN_TIME_MS_PER_EVENT, "ms"),
                };
            default:
                return fail(`unknown event "${event.event}"`);
        }
    };

    // ---- Pure aggregation --------------------------------------------------

    /** A stored day with every field present (older or damaged records included). */
    const normalizeDay = (day) => {
        const base = emptyDay();
        if (!day || typeof day !== "object") return base;
        for (const field of ["shortsRemoved", "reelsRemoved", "shortsRedirects", "reelsRedirects"]) {
            if (Number.isFinite(day[field])) base[field] = day[field];
        }
        for (const field of ["blockedVisits", "unblocks", "screenTimeMs"]) {
            if (day[field] && typeof day[field] === "object") base[field] = { ...day[field] };
        }
        return base;
    };

    const bump = (map, key, amount) => {
        map[key] = (map[key] ?? 0) + amount;
    };

    /** Returns a new day record with a validated event added. */
    const applyEvent = (day, event) => {
        const next = normalizeDay(day);
        switch (event.event) {
            case "removal":
                next[event.kind + "Removed"] += event.count;
                break;
            case "redirect":
                next[event.kind + "Redirects"] += 1;
                break;
            case "blockedVisit":
                bump(next.blockedVisits, event.domain, 1);
                break;
            case "unblock": {
                const current = next.unblocks[event.domain] ?? { count: 0, minutes: 0 };
                next.unblocks[event.domain] = {
                    count: current.count + 1,
                    minutes: current.minutes + event.minutes,
                };
                break;
            }
            case "screenTime":
                bump(next.screenTimeMs, event.domain, event.ms);
                break;
        }
        return next;
    };

    const sumValues = (map) => Object.values(map).reduce((total, n) => total + n, 0);

    /** Headline numbers for one day record. */
    const dayTotals = (day) => {
        const d = normalizeDay(day);
        const unblocks = Object.values(d.unblocks);
        return {
            shortsRemoved: d.shortsRemoved,
            reelsRemoved: d.reelsRemoved,
            shortsRedirects: d.shortsRedirects,
            reelsRedirects: d.reelsRedirects,
            blockedVisits: sumValues(d.blockedVisits),
            unblocks: unblocks.reduce((total, u) => total + (u.count ?? 0), 0),
            unblockMinutes: unblocks.reduce((total, u) => total + (u.minutes ?? 0), 0),
            screenTimeMs: sumValues(d.screenTimeMs),
        };
    };

    /**
     * Sums a set of days: { totals, perSite } where perSite holds
     * blockedVisits / unblocks / unblockMinutes / screenTimeMs keyed by domain.
     * `days` maps day keys to records; missing days count as zero.
     */
    const summarize = (days) => {
        const totals = dayTotals(null);
        const perSite = { blockedVisits: {}, unblocks: {}, unblockMinutes: {}, screenTimeMs: {} };
        for (const raw of Object.values(days)) {
            const day = normalizeDay(raw);
            const t = dayTotals(day);
            for (const field of Object.keys(totals)) totals[field] += t[field];
            for (const [domain, n] of Object.entries(day.blockedVisits)) bump(perSite.blockedVisits, domain, n);
            for (const [domain, ms] of Object.entries(day.screenTimeMs)) bump(perSite.screenTimeMs, domain, ms);
            for (const [domain, u] of Object.entries(day.unblocks)) {
                bump(perSite.unblocks, domain, u.count ?? 0);
                bump(perSite.unblockMinutes, domain, u.minutes ?? 0);
            }
        }
        return { totals, perSite };
    };

    /**
     * One value per day for charts: [{ day, value }] in the order of `dayKeys`.
     * `pick` receives the day's totals (see dayTotals) and the full record.
     */
    const dailySeries = (days, dayKeys, pick) =>
        dayKeys.map((day) => {
            const record = normalizeDay(days[day]);
            return { day, value: pick(dayTotals(record), record) };
        });

    /** The `limit` largest entries of a { domain: number } map, largest first. */
    const topEntries = (map, limit = 5) =>
        Object.entries(map)
            .filter(([, value]) => value > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, limit)
            .map(([domain, value]) => ({ domain, value }));

    /**
     * Consecutive days without a temporary unblock, ending today (today counts
     * while it stays clean). Never reaches before `trackingSince` nor past the
     * retention window (pruned days can't prove they were clean); 0 when
     * nothing has been tracked yet.
     */
    const focusStreak = (days, trackingSince, now = new Date(), maxDays = RETENTION_DAYS) => {
        if (!trackingSince) return 0;
        let streak = 0;
        for (let offset = 0; offset < maxDays; offset++) {
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
            const key = dayKey(date);
            if (key < trackingSince) break;
            if (dayTotals(days[key]).unblocks > 0) break;
            streak += 1;
        }
        return streak;
    };

    /** Estimated time saved (ms) for a set of totals; see TIME_SAVED_MINUTES. */
    const estimateTimeSavedMs = (totals) => {
        const minutes =
            totals.blockedVisits * TIME_SAVED_MINUTES.blockedVisit +
            (totals.shortsRedirects + totals.reelsRedirects) * TIME_SAVED_MINUTES.redirect +
            (totals.shortsRemoved + totals.reelsRemoved) * TIME_SAVED_MINUTES.removal;
        return minutes * 60 * 1000;
    };

    // ---- Storage -----------------------------------------------------------

    /** { "<YYYY-MM-DD>": record } for the requested day keys that have data. */
    const loadDays = async (dayKeys) => {
        const data = await getLocal(dayKeys.map(storageKey));
        const days = {};
        for (const day of dayKeys) {
            const raw = data[storageKey(day)];
            if (raw) days[day] = normalizeDay(parse(raw, null));
        }
        return days;
    };

    const loadMeta = async () => {
        const data = await getLocal([META_KEY]);
        return parse(data[META_KEY], {});
    };

    /**
     * Everything the Insights page needs for the last `count` days and the
     * `count` days before them (for trend arrows), plus the focus streak.
     */
    const loadRange = async (count, now = new Date()) => {
        const all = lastDays(count * 2, now);
        const previousKeys = all.slice(0, count);
        const currentKeys = all.slice(count);
        const meta = await loadMeta();
        // The streak may run past the selected range; read the whole retention window
        const streakDays = await loadDays(lastDays(Math.max(count * 2, RETENTION_DAYS), now));
        const pickDays = (keys) => Object.fromEntries(keys.filter((k) => k in streakDays).map((k) => [k, streakDays[k]]));
        return {
            dayKeys: currentKeys,
            days: pickDays(currentKeys),
            previousDays: pickDays(previousKeys),
            trackingSince: meta.trackingSince ?? null,
            focusStreak: focusStreak(streakDays, meta.trackingSince, now),
        };
    };

    // Writes run one at a time
    let queue = Promise.resolve();
    const enqueue = (run) => {
        const result = queue.then(run);
        queue = result.catch(() => {});
        return result;
    };

    const pruneOldDays = async (now) => {
        const cutoff = lastDays(RETENTION_DAYS, now)[0];
        const all = await getLocal(null);
        const stale = Object.keys(all).filter((key) => {
            const match = key.match(DAY_KEY_PATTERN);
            return match && match[1] < cutoff;
        });
        if (stale.length > 0) await removeLocal(stale);
    };

    /** Validates and adds one event to today's record. Returns the updated record. */
    const record = (rawEvent, now = new Date()) => {
        const event = validateEvent(rawEvent); // throws before anything is queued
        return enqueue(async () => {
            const day = dayKey(now);
            const key = storageKey(day);
            const data = await getLocal([key, META_KEY]);
            const isNewDay = !data[key];
            const updated = applyEvent(parse(data[key], null), event);

            const items = { [key]: JSON.stringify(updated) };
            const meta = parse(data[META_KEY], {});
            // The earliest day ever written: a record for a past day moves it back
            if (!meta.trackingSince || day < meta.trackingSince) {
                items[META_KEY] = JSON.stringify({ ...meta, trackingSince: day });
            }
            await setLocal(items);

            if (isNewDay) await pruneOldDays(now);
            return updated;
        });
    };

    /** Deletes every statistic (tracking starts over with the next event). */
    const clearStats = () =>
        enqueue(async () => {
            const all = await getLocal(null);
            const keys = Object.keys(all).filter(isStatsKey);
            if (keys.length > 0) await removeLocal(keys);
        });

    globalThis.ATTENTION_STATS = Object.freeze({
        DAY_PREFIX,
        META_KEY,
        STATS_MESSAGE,
        RETENTION_DAYS,
        TIME_SAVED_MINUTES,
        MESSAGE_EVENTS,
        // pure
        dayKey,
        lastDays,
        isStatsKey,
        validateEvent,
        applyEvent,
        dayTotals,
        summarize,
        dailySeries,
        topEntries,
        focusStreak,
        estimateTimeSavedMs,
        // storage
        loadDays,
        loadRange,
        record,
        clearStats,
    });
})();
