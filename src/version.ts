import { createRequire } from "node:module";

/**
 * package.json is the single source of truth: release-please bumps it, and npm
 * ships it in every tarball regardless of the `files` list. A literal here
 * would only ever be as current as the last person who remembered to edit it —
 * which is how `--version` reported 0.1.0 from the 0.1.1 release.
 *
 * Read via createRequire rather than a static import: `rootDir` is src/, so
 * importing a file above it would fail the build, and the resolution has to
 * happen relative to the emitted dist/version.js at runtime anyway.
 */
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const VERSION = version;
