import { beforeEach } from "vitest";
import { createChromeMock } from "./chromeMock.js";

// One mock per test file (setup files run once per file). Scripts under test
// read `chrome` from the global at call time, so listeners they register
// during import stay reachable through chrome.__messageListeners etc.
globalThis.chrome = createChromeMock();

beforeEach(() => {
    globalThis.chrome.__reset();
});
