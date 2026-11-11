// Settings page: blocked sites with schedules, the Shorts/Reels toggles and
// the unblock PIN. All data lives in settingsStore.js; this module only
// renders it and forwards changes. The static page shell is settings.html.

// Publish globalThis.ATTENTION_ICONS and globalThis.ATTENTION_SETTINGS
import "./icons.js";
import "./settingsStore.js";

const SETTINGS = globalThis.ATTENTION_SETTINGS;
const { trash: TRASH_ICON, edit: EDIT_ICON } = globalThis.ATTENTION_ICONS.markup;

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---- UI state that must survive re-renders (storage changes re-render) -----

const ui = {
    // Schedule editor: which site it is open for and what has been picked so far
    editing: null, // null or { siteId, mode: "always" | "custom", start, end, days: [..], error }
    // PIN form: entered values survive unrelated re-renders; cleared on success
    pin: { first: "", second: "", error: "", notice: "" },
};

// ---- Small DOM helpers (textContent only for user data; innerHTML only for
// the static icon markup from icons.js) --------------------------------------

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const iconButton = (className, label, iconMarkup, onClick) => {
    const button = el("button", className);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = iconMarkup;
    button.addEventListener("click", onClick);
    return button;
};

const textButton = (className, label, onClick) => {
    const button = el("button", className, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
};

// ---- Wording ----------------------------------------------------------------

// "13:05" -> "1:05 PM"
const formatClock = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    const suffix = hours < 12 ? "AM" : "PM";
    const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
    return `${twelveHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

const describeDays = (days) => {
    if (!days || days.length === 0 || days.length === 7) return "every day";
    const names = [...days].sort().map((d) => SHORT_DAYS[d]);
    if (names.length === 1) return "on " + names[0];
    return "on " + names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
};

const toMinutes = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
};

const scheduleSummary = (site) => {
    if (!site.enabled) return "Disabled";
    if (!site.schedule) return "Always blocked";
    const { start, end, days } = site.schedule;
    const overnight = toMinutes(end) < toMinutes(start) ? " (overnight)" : "";
    return `${formatClock(start)} – ${formatClock(end)}${overnight} ${describeDays(days)}`;
};

// ---- Blocked sites ----------------------------------------------------------

const openEditor = (site) => {
    ui.editing = {
        siteId: site.id,
        mode: site.schedule ? "custom" : "always",
        start: site.schedule?.start ?? "13:00",
        end: site.schedule?.end ?? "18:00",
        days: site.schedule?.days ?? [],
        error: "",
    };
};

const closeEditor = () => {
    ui.editing = null;
};

const saveEditor = async () => {
    const editing = ui.editing;
    const schedule = editing.mode === "always" ? null : { start: editing.start, end: editing.end, days: editing.days };
    try {
        await SETTINGS.setSchedule(editing.siteId, schedule);
        closeEditor();
    } catch (error) {
        editing.error = error.message;
    }
    render();
};

const renderEditor = (site) => {
    const editing = ui.editing;
    const form = el("form", "schedule-editor");
    form.setAttribute("aria-label", "Schedule for " + site.domain);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveEditor();
    });

    const modes = el("div", "schedule-modes");
    for (const [mode, label] of [
        ["always", "Always blocked"],
        ["custom", "Custom schedule"],
    ]) {
        const wrapper = el("label");
        const radio = el("input");
        radio.type = "radio";
        radio.name = "schedule-mode";
        radio.value = mode;
        radio.checked = editing.mode === mode;
        radio.addEventListener("change", () => {
            editing.mode = mode;
            editing.error = "";
            render();
        });
        wrapper.append(radio, el("span", null, label));
        modes.appendChild(wrapper);
    }
    form.appendChild(modes);

    if (editing.mode === "custom") {
        const times = el("div", "schedule-times");
        const timeInput = (field, label) => {
            const input = el("input");
            input.type = "time";
            input.value = editing[field];
            input.required = true;
            input.setAttribute("aria-label", label);
            input.addEventListener("input", () => {
                editing[field] = input.value;
                editing.error = "";
            });
            return input;
        };
        times.append("From", timeInput("start", "Blocked from"), "to", timeInput("end", "Blocked until"));
        form.appendChild(times);

        const chips = el("div", "day-chips");
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", "On days");
        SHORT_DAYS.forEach((name, day) => {
            const chip = el("label", "day-chip");
            const checkbox = el("input");
            checkbox.type = "checkbox";
            checkbox.checked = editing.days.includes(day);
            checkbox.setAttribute("aria-label", name);
            checkbox.addEventListener("change", () => {
                editing.days = checkbox.checked ? [...editing.days, day] : editing.days.filter((d) => d !== day);
                editing.error = "";
            });
            chip.append(checkbox, el("span", null, name));
            chips.appendChild(chip);
        });
        form.appendChild(chips);

        form.appendChild(
            el(
                "p",
                "schedule-hint",
                "No days ticked means every day. An end time before the start runs overnight into the next morning."
            )
        );
    }

    const error = el("div", "form-error", editing.error);
    error.setAttribute("role", "alert");

    const actions = el("div", "form-actions");
    const cancel = textButton("btn", "Cancel", () => {
        closeEditor();
        render();
    });
    const save = el("button", "btn btn-primary", "Save");
    save.type = "submit";
    actions.append(cancel, save);

    form.append(error, actions);
    return form;
};

const renderSiteRow = (site) => {
    const row = el("li", "site-row" + (site.enabled ? "" : " disabled"));
    row.dataset.domain = site.domain;

    const main = el("div", "site-row-main");
    main.append(el("span", "site-domain", site.domain), el("span", "site-summary", scheduleSummary(site)));

    const actions = el("div", "site-actions");

    const switchLabel = el("label", "switch");
    switchLabel.title = site.enabled ? "Disable blocking" : "Enable blocking";
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = site.enabled;
    toggle.setAttribute("aria-label", "Block " + site.domain);
    toggle.addEventListener("change", () => SETTINGS.toggleSite(site.id, toggle.checked).catch(() => render()));
    switchLabel.append(toggle, el("span", "slider"));

    const editButton = iconButton("icon-action", "Edit schedule for " + site.domain, EDIT_ICON, () => {
        if (ui.editing?.siteId === site.id) closeEditor();
        else openEditor(site);
        render();
    });
    editButton.setAttribute("aria-expanded", String(ui.editing?.siteId === site.id));

    const deleteButton = iconButton("icon-action danger", "Remove " + site.domain, TRASH_ICON, () =>
        SETTINGS.removeSite(site.id).catch(() => render())
    );

    actions.append(switchLabel, editButton, deleteButton);
    main.appendChild(actions);
    row.appendChild(main);

    if (ui.editing?.siteId === site.id) row.appendChild(renderEditor(site));
    return row;
};

const renderSites = (sites) => {
    const list = document.getElementById("site-list");
    list.replaceChildren();

    // The editor belongs to a site that may have been removed in another tab
    if (ui.editing && !sites.some((site) => site.id === ui.editing.siteId)) closeEditor();

    if (sites.length === 0) {
        list.appendChild(el("li", "site-empty", "No blocked sites. Add one above."));
        return;
    }
    for (const site of sites) list.appendChild(renderSiteRow(site));
};

const bindAddSiteForm = () => {
    const form = document.getElementById("add-site-form");
    const input = document.getElementById("add-site-input");
    const error = document.getElementById("add-site-error");

    input.addEventListener("input", () => (error.textContent = ""));
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            await SETTINGS.addSite(input.value);
            input.value = "";
            input.focus();
        } catch (failure) {
            error.textContent = failure.message;
        }
    });
};

// ---- Shorts & Reels toggles -------------------------------------------------

const bindHideToggles = () => {
    for (const [id, key] of [
        ["toggle-shorts", "youtubeShorts"],
        ["toggle-reels", "facebookReels"],
    ]) {
        const checkbox = document.getElementById(id);
        checkbox.addEventListener("change", () => SETTINGS.setHideToggle(key, checkbox.checked).catch(() => render()));
    }
};

const renderToggles = (hideShortsReels) => {
    document.getElementById("toggle-shorts").checked = hideShortsReels.youtubeShorts;
    document.getElementById("toggle-reels").checked = hideShortsReels.facebookReels;
};

// ---- Unblock PIN ------------------------------------------------------------

const submitPin = async () => {
    const pin = ui.pin;
    if (pin.first !== pin.second) {
        pin.error = "The PINs don't match";
        pin.notice = "";
        render();
        return;
    }
    const hadPin = Boolean((await SETTINGS.loadSettings()).pinHash);
    try {
        await SETTINGS.setPin(pin.first);
        ui.pin = { first: "", second: "", error: "", notice: hadPin ? "PIN changed" : "PIN set" };
    } catch (error) {
        pin.error = error.message;
        pin.notice = "";
    }
    render();
};

const removePin = async () => {
    const accepted = window.confirm("Remove the PIN? Active temporary unblocks are cleared and blocked pages will no longer offer to unblock.");
    if (!accepted) return;
    await SETTINGS.clearPin();
    ui.pin = { first: "", second: "", error: "", notice: "PIN removed" };
    render();
};

const renderPin = (pinHash) => {
    const body = document.getElementById("pin-body");
    const hasPin = Boolean(pinHash);
    body.replaceChildren();

    body.appendChild(
        el("p", "pin-status", hasPin ? "A PIN is set." : "No PIN set: blocked pages don't offer a temporary unblock.")
    );

    const form = el("form", "pin-form");
    form.id = "pin-form";
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitPin();
    });

    const pinInput = (field, label, id) => {
        const wrapper = el("label", null, label);
        const input = el("input");
        input.type = "password";
        input.id = id;
        input.autocomplete = "off";
        input.required = true;
        input.value = ui.pin[field];
        input.addEventListener("input", () => {
            ui.pin[field] = input.value;
            ui.pin.error = "";
            ui.pin.notice = "";
        });
        wrapper.appendChild(input);
        return wrapper;
    };

    form.append(
        pinInput("first", hasPin ? "New PIN" : "PIN (at least " + SETTINGS.MIN_PIN_LENGTH + " characters)", "pin-first"),
        pinInput("second", "Repeat PIN", "pin-second")
    );

    const error = el("div", "form-error", ui.pin.error);
    error.id = "pin-error";
    error.setAttribute("role", "alert");

    const notice = el("div", "pin-notice", ui.pin.notice);
    notice.id = "pin-notice";
    notice.setAttribute("role", "status");

    const actions = el("div", "pin-actions");
    const submit = el("button", "btn btn-primary", hasPin ? "Change PIN" : "Set PIN");
    submit.type = "submit";
    actions.appendChild(submit);
    if (hasPin) actions.appendChild(textButton("btn btn-danger", "Remove PIN", removePin));

    form.append(error, notice, actions);
    body.appendChild(form);
};

// ---- Page -------------------------------------------------------------------

const render = async () => {
    const [sites, settings] = await Promise.all([SETTINGS.loadBlockedSites(), SETTINGS.loadSettings()]);
    renderSites(sites);
    renderToggles(settings.hideShortsReels);
    renderPin(settings.pinHash);
};

document.addEventListener("DOMContentLoaded", () => {
    bindAddSiteForm();
    bindHideToggles();
    render();
});

// Follow changes from other contexts (another settings tab, the blocked page,
// a different device via sync) without a reload
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (SETTINGS.SITES_KEY in changes || SETTINGS.SETTINGS_KEY in changes)) render();
});
