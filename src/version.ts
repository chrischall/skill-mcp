/**
 * The single place this package's version lives in source. release-please
 * rewrites the literal below (registered in `release-please-config.json`'s
 * `extra-files`), and `tests/version-sync.test.ts` fails if it ever drifts
 * from `package.json`.
 *
 * Keep the marker comment on the export line and nowhere else — the sync test
 * flags every line carrying that literal, prose included.
 */
export const VERSION = '0.0.0'; // x-release-please-version
