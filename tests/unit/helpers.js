/**
 * Waits long enough for the content script's MutationObserver -> rAF sweep
 * to run: one microtask turn (observer callback) + one animation frame.
 */
export async function flushRemoval() {
    await Promise.resolve();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Resolves once all currently queued promise callbacks have run. */
export function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
