/**
 * Extension settings: blocked sites with optional schedules, the Shorts/Reels
 * visibility toggles, the unblock PIN and temporary unblocks.
 *
 * Loaded three ways, like bookmarkStore.js: as a content script before
 * contentScript.js, via `import "./settingsStore.js"` from extension pages and
 * from the background service worker (a module). Publishes
 * globalThis.ATTENTION_SETTINGS.
 *
 * Storage:
 *  - chrome.storage.sync (settings follow the user across devices):
 *     - attention_blocked_sites: { nextRuleId, sites: [{ id, ruleId, domain,
 *       enabled, schedule }] }. `ruleId` is the site's permanent
 *       declarativeNetRequest rule id; `schedule` is null (always blocked) or
 *       { start: "13:00", end: "18:00", days: [5, 6] } in local time, where
 *       days follow Date#getDay (0 = Sunday) and an empty list means every day.
 *     - attention_settings: { hideShortsReels: { youtubeShorts, facebookReels },
 *       pinHash }. The PIN is a self-control speed bump, not security: it is
 *       stored as a bare SHA-256 digest and can be reset without knowing it.
 *  - chrome.storage.local (per device on purpose: unblocking here should not
 *    unblock everywhere):
 *     - attention_temp_unblocks: { "<domain>": expiresAtMs }
 *
 * All values are JSON strings, like the bookmark keys.
 *
 * The Shorts/Reels toggles also cover the Shorts and Reels pages themselves
 * (youtube.com/shorts/..., facebook.com/reel/... and /reels/): with a toggle
 * on, those pages send the user to the site's home page. Direct loads are
 * redirected by the declarativeNetRequest rules from buildShortsReelsRules();
 * in-app navigation never reaches the network layer, so contentScript.js
 * catches it with shortsReelsToggleFor().
 */
(() => {
    const SITES_KEY = "attention_blocked_sites";
    const SETTINGS_KEY = "attention_settings";
    const TEMP_UNBLOCKS_KEY = "attention_temp_unblocks";

    const MIN_PIN_LENGTH = 4;
    const FIRST_RULE_ID = 1; // declarativeNetRequest rule ids must be >= 1

    const DEFAULT_SETTINGS = Object.freeze({
        hideShortsReels: Object.freeze({ youtubeShorts: true, facebookReels: true }),
        pinHash: null,
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

    const getSynced = (keys) => new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
    const setSynced = (items) => new Promise((resolve) => chrome.storage.sync.set(items, resolve));
    const getLocal = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    const setLocal = (items) => new Promise((resolve) => chrome.storage.local.set(items, resolve));

    // ---- Pure helpers ------------------------------------------------------

    /**
     * Turns whatever the user typed ("https://www.Facebook.com/feed", "reddit.com/r/all",
     * "example.com:8080") into a bare lowercase domain. Throws with a
     * user-facing message when no domain can be made of it.
     */
    const normalizeDomain = (input) => {
        const typed = String(input ?? "").trim();
        if (!typed) throw new Error("Enter a site to block");
        let domain = typed.toLowerCase();
        domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
        domain = domain.split(/[/?#]/)[0]; // path, query, fragment
        domain = domain.replace(/^[^@]*@/, ""); // credentials
        domain = domain.replace(/:\d*$/, ""); // port
        domain = domain.replace(/^www\./, "");
        domain = domain.replace(/\.$/, ""); // trailing dot
        const isHostname = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
        if (!isHostname) throw new Error(`"${typed}" doesn't look like a site address`);
        return domain;
    };

    /** True when the URL's host is the domain or a subdomain of it. */
    const domainMatches = (domain, url) => {
        let host;
        try {
            host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
        } catch {
            return false;
        }
        return host === domain || host.endsWith("." + domain);
    };

    const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

    const toMinutes = (time) => {
        const [, hours, minutes] = time.match(TIME_PATTERN);
        return Number(hours) * 60 + Number(minutes);
    };

    /** Normalizes and validates { start, end, days }; throws a user-facing Error. */
    const validateSchedule = (schedule) => {
        if (schedule === null || schedule === undefined) return null;
        const { start, end, days } = schedule;
        for (const time of [start, end]) {
            if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
                throw new Error("Times must look like 13:00");
            }
        }
        if (toMinutes(start) === toMinutes(end)) throw new Error("Start and end times must be different");
        if (!Array.isArray(days) && days !== undefined) throw new Error("Days must be a list");
        const uniqueDays = [...new Set(days ?? [])].sort();
        if (uniqueDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
            throw new Error("Days must be between 0 (Sunday) and 6 (Saturday)");
        }
        const pad = (time) => time.padStart(5, "0");
        return { start: pad(start), end: pad(end), days: uniqueDays };
    };

    /**
     * True when the schedule says "blocked right now" (local time). No schedule
     * means always blocked. The start minute is blocked, the end minute is not.
     * An end before the start spans midnight: 22:00-06:00 on Friday blocks
     * Friday night and Saturday morning.
     */
    const isScheduleActive = (schedule, now = new Date()) => {
        if (!schedule) return true;
        const dayAllowed = (day) => !schedule.days || schedule.days.length === 0 || schedule.days.includes(day);
        const minutes = now.getHours() * 60 + now.getMinutes();
        const start = toMinutes(schedule.start);
        const end = toMinutes(schedule.end);
        if (start < end) return dayAllowed(now.getDay()) && minutes >= start && minutes < end;
        const yesterday = (now.getDay() + 6) % 7;
        return (dayAllowed(now.getDay()) && minutes >= start) || (dayAllowed(yesterday) && minutes < end);
    };

    /** True when this site should be blocked right now. */
    const isSiteBlocked = (site, tempUnblocks = {}, now = new Date()) => {
        if (!site.enabled) return false;
        const unblockedUntil = tempUnblocks[site.domain];
        if (unblockedUntil && unblockedUntil > now.getTime()) return false;
        return isScheduleActive(site.schedule, now);
    };

    /** The sites that should have an active blocking rule right now. */
    const activeSites = (sites, tempUnblocks = {}, now = new Date()) =>
        sites.filter((site) => isSiteBlocked(site, tempUnblocks, now));

    /**
     * declarativeNetRequest rules for the given (active) sites. "||domain^"
     * matches the domain and its subdomains but not lookalikes
     * (facebook.com.evil.com), for top-level navigations only.
     */
    const buildRules = (sites) =>
        sites.map((site) => ({
            id: site.ruleId,
            priority: 1,
            action: {
                type: "redirect",
                redirect: { extensionPath: "/blocked.html?site=" + encodeURIComponent(site.domain) },
            },
            condition: {
                urlFilter: "||" + site.domain + "^",
                resourceTypes: ["main_frame"],
            },
        }));

    // ---- Shorts / Reels pages ----------------------------------------------

    // Far above the ids handed out to blocked sites (which count up from 1)
    const SHORTS_REELS_RULE_IDS = Object.freeze({ youtubeShorts: 1_000_001, facebookReels: 1_000_002 });

    // Added by the redirect rules to the home page URL so the content script
    // there can count the redirect (and remove the marker from the address bar)
    const REDIRECT_MARKER = "attention-redirect";

    const SHORTS_REELS_PAGES = Object.freeze({
        youtubeShorts: Object.freeze({ domain: "youtube.com", path: "shorts", kind: "shorts" }),
        facebookReels: Object.freeze({ domain: "facebook.com", path: "reels?", kind: "reels" }),
    });

    const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    /**
     * "youtubeShorts" / "facebookReels" when the URL is a Shorts or Reels
     * page (whatever the toggles say), otherwise null. Only the first path
     * segment counts: /shorts/abc and /reel/123 match, /watch?v=shorts and
     * /@channel/shorts don't.
     */
    const shortsReelsToggleFor = (url) => {
        let pathname;
        try {
            pathname = new URL(url).pathname;
        } catch {
            return null;
        }
        for (const [toggle, page] of Object.entries(SHORTS_REELS_PAGES)) {
            if (domainMatches(page.domain, url) && new RegExp(`^/${page.path}(/|$)`, "i").test(pathname)) return toggle;
        }
        return null;
    };

    /**
     * Redirect rules for the Shorts/Reels pages whose toggle is on. They keep
     * the host (m.youtube.com stays on m.youtube.com), go to its home page and
     * add the #attention-redirect=<kind> marker. A site blocked as a whole
     * still ends on the blocked page: the home page it redirects to is blocked.
     */
    const buildShortsReelsRules = (hideShortsReels = DEFAULT_SETTINGS.hideShortsReels) =>
        Object.entries(SHORTS_REELS_PAGES)
            .filter(([toggle]) => hideShortsReels[toggle])
            .map(([toggle, page]) => ({
                id: SHORTS_REELS_RULE_IDS[toggle],
                priority: 1,
                action: {
                    type: "redirect",
                    redirect: { regexSubstitution: `\\1/#${REDIRECT_MARKER}=${page.kind}` },
                },
                condition: {
                    regexFilter: `^(https?://([a-z0-9-]+\\.)*${escapeRegex(page.domain)})/${page.path}([/?#].*)?$`,
                    isUrlFilterCaseSensitive: false,
                    resourceTypes: ["main_frame"],
                },
            }));

    const atTime = (date, time) => {
        const result = new Date(date);
        result.setHours(Math.floor(toMinutes(time) / 60), toMinutes(time) % 60, 0, 0);
        return result;
    };

    /**
     * The next instant (ms epoch) at which some site's blocked state can
     * change — a schedule boundary or a temporary unblock expiry — or null when
     * nothing will change on its own. Recomputing on a boundary that happens
     * not to flip any state is harmless: rule syncing is idempotent.
     */
    const nextTransition = (sites, tempUnblocks = {}, now = new Date()) => {
        const nowMs = now.getTime();
        let next = null;
        const consider = (ms) => {
            if (ms > nowMs && (next === null || ms < next)) next = ms;
        };

        for (const site of sites) {
            if (!site.enabled) continue;
            const expiry = tempUnblocks[site.domain];
            if (expiry) consider(expiry);
            if (!site.schedule) continue;

            const { start, end, days } = site.schedule;
            const overnight = toMinutes(end) < toMinutes(start);
            // Walk from yesterday (whose overnight window can end this
            // morning) through the next 7 days, so every allowed weekday is
            // seen at least once; consider() drops instants already past
            for (let offset = -1; offset <= 7; offset++) {
                const day = new Date(now);
                day.setDate(day.getDate() + offset);
                const allowed = !days || days.length === 0 || days.includes(day.getDay());
                if (!allowed) continue;
                consider(atTime(day, start).getTime());
                const endDay = new Date(day);
                if (overnight) endDay.setDate(endDay.getDate() + 1);
                consider(atTime(endDay, end).getTime());
            }
        }
        return next;
    };

    // ---- Blocked sites (chrome.storage.sync) -------------------------------

    const loadSitesRecord = async () => {
        const data = await getSynced([SITES_KEY]);
        const record = parse(data[SITES_KEY], {});
        const sites = Array.isArray(record.sites) ? record.sites : [];
        const nextRuleId = Number.isInteger(record.nextRuleId)
            ? record.nextRuleId
            : Math.max(FIRST_RULE_ID, ...sites.map((s) => s.ruleId + 1));
        return { nextRuleId, sites };
    };

    /** The blocked sites, in the order they were added. */
    const loadBlockedSites = async () => (await loadSitesRecord()).sites;

    // Mutations from one page/tab run one at a time, so two quick clicks can't
    // both read the same state and overwrite each other (same pattern as
    // bookmarkStore.js).
    let queue = Promise.resolve();
    const enqueue = (run) => {
        const result = queue.then(run);
        queue = result.catch(() => {});
        return result;
    };

    const mutateSites = (change) =>
        enqueue(async () => {
            const record = await loadSitesRecord();
            const result = change(record);
            await setSynced({ [SITES_KEY]: JSON.stringify(record) });
            return result;
        });

    const findSite = (sites, siteId) => {
        const site = sites.find((s) => s.id === siteId);
        if (!site) throw new Error("That site is no longer in the list");
        return site;
    };

    const newSiteId = () => "site-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

    /** Adds a blocked site (always blocked until a schedule is set). */
    const addSite = (rawDomain) =>
        mutateSites((record) => {
            const domain = normalizeDomain(rawDomain);
            if (record.sites.some((s) => s.domain === domain)) {
                throw new Error(`${domain} is already in the list`);
            }
            const site = { id: newSiteId(), ruleId: record.nextRuleId, domain, enabled: true, schedule: null };
            record.nextRuleId += 1;
            record.sites.push(site);
            return site;
        });

    const removeSite = (siteId) =>
        mutateSites((record) => {
            const site = findSite(record.sites, siteId);
            record.sites = record.sites.filter((s) => s !== site);
            return site;
        });

    /** Enables or disables a site without forgetting it (or its schedule). */
    const toggleSite = (siteId, enabled) =>
        mutateSites((record) => {
            const site = findSite(record.sites, siteId);
            site.enabled = Boolean(enabled);
            return site;
        });

    /** Sets a site's schedule; null means always blocked. */
    const setSchedule = (siteId, schedule) =>
        mutateSites((record) => {
            const site = findSite(record.sites, siteId);
            site.schedule = validateSchedule(schedule);
            return site;
        });

    // ---- Other settings (chrome.storage.sync) ------------------------------

    /** Reads { hideShortsReels, pinHash } with defaults filled in. */
    const loadSettings = async () => {
        const data = await getSynced([SETTINGS_KEY]);
        const stored = parse(data[SETTINGS_KEY], {});
        return {
            ...DEFAULT_SETTINGS,
            ...stored,
            hideShortsReels: { ...DEFAULT_SETTINGS.hideShortsReels, ...stored.hideShortsReels },
        };
    };

    const mutateSettings = (change) =>
        enqueue(async () => {
            const settings = await loadSettings();
            const result = change(settings);
            await setSynced({ [SETTINGS_KEY]: JSON.stringify(settings) });
            return result;
        });

    /** Shows or hides YouTube Shorts / Facebook Reels. */
    const setHideToggle = (toggle, hidden) => {
        if (!(toggle in DEFAULT_SETTINGS.hideShortsReels)) {
            throw new Error(`Unknown toggle "${toggle}"`);
        }
        return mutateSettings((settings) => {
            settings.hideShortsReels[toggle] = Boolean(hidden);
        });
    };

    // ---- Unblock PIN (hash in sync storage) --------------------------------

    const hashPin = async (pin) => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(pin)));
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };

    const setPin = async (pin) => {
        const trimmed = String(pin ?? "").trim();
        if (trimmed.length < MIN_PIN_LENGTH) throw new Error(`Use at least ${MIN_PIN_LENGTH} characters`);
        const hash = await hashPin(trimmed);
        await mutateSettings((settings) => {
            settings.pinHash = hash;
        });
    };

    /** False when no PIN is set (the blocked page offers no unblock then). */
    const verifyPin = async (pin) => {
        const { pinHash } = await loadSettings();
        if (!pinHash) return false;
        return (await hashPin(String(pin ?? "").trim())) === pinHash;
    };

    /**
     * Forgot-PIN reset: no current PIN needed (it is a speed bump, not
     * security), but active temporary unblocks go with it so a reset can never
     * extend one.
     */
    const clearPin = async () => {
        await mutateSettings((settings) => {
            settings.pinHash = null;
        });
        await clearTempUnblocks();
    };

    // ---- Temporary unblocks (chrome.storage.local) -------------------------

    // Reads and prunes in one place; callers wrap it in a single queue entry
    const readTempUnblocks = async (nowMs) => {
        const data = await getLocal([TEMP_UNBLOCKS_KEY]);
        const stored = parse(data[TEMP_UNBLOCKS_KEY], {});
        const current = {};
        for (const [domain, expiry] of Object.entries(stored)) {
            if (typeof expiry === "number" && expiry > nowMs) current[domain] = expiry;
        }
        return { stored, current };
    };

    /** Reads { domain: expiresAtMs }, dropping (and persisting away) expired entries. */
    const getTempUnblocks = (nowMs = Date.now()) =>
        enqueue(async () => {
            const { stored, current } = await readTempUnblocks(nowMs);
            if (Object.keys(current).length !== Object.keys(stored).length) {
                await setLocal({ [TEMP_UNBLOCKS_KEY]: JSON.stringify(current) });
            }
            return current;
        });

    /** Lets a domain through until now + minutes; returns the expiry (ms epoch). */
    const grantTempUnblock = (domain, minutes, nowMs = Date.now()) =>
        enqueue(async () => {
            if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Choose how long to unblock for");
            const { current } = await readTempUnblocks(nowMs);
            const expiresAt = nowMs + minutes * 60 * 1000;
            await setLocal({ [TEMP_UNBLOCKS_KEY]: JSON.stringify({ ...current, [domain]: expiresAt }) });
            return expiresAt;
        });

    const clearTempUnblocks = () =>
        enqueue(async () => {
            await setLocal({ [TEMP_UNBLOCKS_KEY]: JSON.stringify({}) });
        });

    globalThis.ATTENTION_SETTINGS = Object.freeze({
        SITES_KEY,
        SETTINGS_KEY,
        TEMP_UNBLOCKS_KEY,
        MIN_PIN_LENGTH,
        // pure
        normalizeDomain,
        domainMatches,
        validateSchedule,
        isScheduleActive,
        isSiteBlocked,
        activeSites,
        buildRules,
        nextTransition,
        // Shorts / Reels pages
        SHORTS_REELS_RULE_IDS,
        REDIRECT_MARKER,
        shortsReelsToggleFor,
        buildShortsReelsRules,
        // blocked sites
        loadBlockedSites,
        addSite,
        removeSite,
        toggleSite,
        setSchedule,
        // settings + PIN
        loadSettings,
        setHideToggle,
        setPin,
        verifyPin,
        clearPin,
        // temporary unblocks
        getTempUnblocks,
        grantTempUnblock,
        clearTempUnblocks,
    });
})();
