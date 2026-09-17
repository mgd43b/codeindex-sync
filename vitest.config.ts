import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most suites spawn real processes — git, the built CLI, stub backends — and
    // on a loaded machine a handful of those can outlast Vitest's 5s default,
    // failing a correct test as a timeout.
    testTimeout: 30_000,
  },
});
