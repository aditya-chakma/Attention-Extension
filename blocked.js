// The page a blocked site is redirected to (see the declarativeNetRequest
// rules in background.js). It explains why the site is blocked and, when a
// PIN is set, lets the user lift the block for a while. The PIN itself is
// checked by the background worker, which also updates the rules before
// replying, so the page can navigate straight away.

// Publish globalThis.ATTENTION_ICONS and globalThis.ATTENTION_SETTINGS
import "./icons.js";
import "./settingsStore.js";

const SETTINGS = globalThis.ATTENTION_SETTINGS;

const UNBLOCK_MINUTES = [5, 15, 30, 60];
const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

// "13:05" -> "1:05 PM"
const formatClock = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    const suffix = hours < 12 ? "AM" : "PM";
    const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
    return `${twelveHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

// [5, 6] -> "on Fridays and Saturdays"; [] or all seven -> "every day"
const describeDays = (days) => {
    if (!days || days.length === 0 || days.length === 7) return "every day";
    const names = [...days].sort().map((d) => DAY_NAMES[d]);
    if (names.length === 1) return "on " + names[0];
    return "on " + names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
};

const describeSchedule = (schedule) => {
    if (!schedule) return "Blocked all day, every day.";
    return `Blocked from ${formatClock(schedule.start)} to ${formatClock(schedule.end)} ${describeDays(schedule.days)}.`;
};

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const link = (href, text, className) => {
    const anchor = el("a", className, text);
    anchor.href = href;
    return anchor;
};

// The domain comes from the redirect rule; anything else in the query string
// is not trusted to be a domain
const requestedDomain = () => {
    const raw = new URLSearchParams(window.location.search).get("site");
    try {
        return SETTINGS.normalizeDomain(raw);
    } catch {
        return null;
    }
};

const siteUrl = (domain) => "https://" + domain + "/";

const renderHeading = (card, domain) => {
    const heading = el("h1");
    if (domain) {
        heading.append(el("span", "domain", domain), " is blocked");
    } else {
        heading.textContent = "This site is blocked";
    }
    card.appendChild(heading);
};

const renderUnblockForm = (card, domain) => {
    const section = el("section", "blocked-section");
    section.appendChild(el("h2", null, "Need it anyway?"));

    const form = el("form", "unblock-form");
    form.id = "unblock-form";
    form.setAttribute("aria-label", "Unblock temporarily");

    const fields = el("div", "unblock-fields");

    const pinLabel = el("label", null, "PIN");
    const pin = el("input");
    pin.type = "password";
    pin.id = "pin";
    pin.autocomplete = "off";
    pin.required = true;
    pin.setAttribute("aria-label", "PIN");
    pinLabel.appendChild(pin);

    const durationLabel = el("label", null, "Unblock for");
    const duration = el("select");
    duration.id = "duration";
    duration.setAttribute("aria-label", "Unblock for");
    for (const minutes of UNBLOCK_MINUTES) {
        const option = el("option", null, minutes === 60 ? "1 hour" : minutes + " minutes");
        option.value = String(minutes);
        duration.appendChild(option);
    }
    durationLabel.appendChild(duration);

    fields.append(pinLabel, durationLabel);

    const error = el("div", "form-error");
    error.id = "unblock-error";
    error.setAttribute("role", "alert");

    const submit = el("button", "btn btn-primary", "Unblock");
    submit.type = "submit";

    form.append(fields, error, submit);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
            const reply = await chrome.runtime.sendMessage({
                type: "TEMP_UNBLOCK",
                domain,
                minutes: Number(duration.value),
                pin: pin.value,
            });
            if (reply && reply.ok) {
                // The rules are already updated; go to the site in this tab
                chrome.tabs.update({ url: siteUrl(domain) });
                return;
            }
            error.textContent = (reply && reply.error) || "Could not unblock the site";
        } catch {
            error.textContent = "Could not reach the extension. Try reloading this page.";
        }
        submit.disabled = false;
        pin.value = "";
        pin.focus();
    });

    section.appendChild(form);
    card.appendChild(section);
};

const renderNoPin = (card) => {
    const section = el("section", "blocked-section");
    const note = el("p", "blocked-note");
    note.append("To unblock a site for a while, set a PIN in ", link("settings.html#pin", "Settings"), ".");
    section.appendChild(note);
    card.appendChild(section);
};

const renderLinks = (card, hasPin) => {
    const links = el("nav", "blocked-links");
    links.setAttribute("aria-label", "More");
    if (hasPin) links.appendChild(link("settings.html#pin", "Forgot your PIN? Reset it in Settings"));
    links.appendChild(link("settings.html", "Blocked sites settings"));
    links.appendChild(link("videos.html", "Bookmarked videos"));
    card.appendChild(links);
};

const render = async () => {
    const card = document.getElementById("blocked");
    if (!card) return;

    const domain = requestedDomain();
    const [sites, settings, unblocks] = await Promise.all([
        SETTINGS.loadBlockedSites(),
        SETTINGS.loadSettings(),
        SETTINGS.getTempUnblocks(),
    ]);
    const site = domain ? sites.find((s) => s.domain === domain) : null;
    const hasPin = Boolean(settings.pinHash);

    card.replaceChildren();
    renderHeading(card, domain);

    if (domain && (!site || !SETTINGS.isSiteBlocked(site, unblocks))) {
        // Removed, disabled, outside its schedule or just unblocked (possibly
        // from another tab): nothing stops the user any more
        card.appendChild(el("p", "blocked-reason", "This site is not blocked right now."));
        card.appendChild(link(siteUrl(domain), "Continue to " + domain, "continue-link"));
        renderLinks(card, hasPin);
        return;
    }

    if (site) {
        card.appendChild(el("p", "blocked-reason", describeSchedule(site.schedule)));
        if (site.schedule) card.appendChild(el("p", "blocked-until", "Blocked until " + formatClock(site.schedule.end)));
    } else {
        card.appendChild(el("p", "blocked-reason", "Access to this site has been restricted."));
    }

    if (domain) {
        if (hasPin) renderUnblockForm(card, domain);
        else renderNoPin(card);
    }
    renderLinks(card, hasPin);
};

document.addEventListener("DOMContentLoaded", () => {
    const icon = document.querySelector("#settings-link .icon");
    if (icon) icon.innerHTML = globalThis.ATTENTION_ICONS.markup.gear;
    render();
});

// Follow changes made elsewhere while this page is open: the site removed from
// the list, its schedule edited, a PIN set or an unblock granted in another tab
chrome.storage.onChanged.addListener((changes, area) => {
    const relevant =
        (area === "sync" && (SETTINGS.SITES_KEY in changes || SETTINGS.SETTINGS_KEY in changes)) ||
        (area === "local" && SETTINGS.TEMP_UNBLOCKS_KEY in changes);
    if (relevant) render();
});
