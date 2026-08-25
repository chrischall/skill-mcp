// Invariant: every `// x-release-please-version` annotation in src/ must hold a
// version string matching package.json's `version`.
//
// The recurring bug it guards: a VERSION constant drifting from package.json
// because release-please's `extra-files` registration lacks the marker, so the
// bump is silently skipped every release. The walk is the shared helper from
// `@chrischall/mcp-utils/test`, so registering a new version-bearing constant
// only needs the comment on its line.
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version sync', () => {
  it('every `x-release-please-version` annotation matches package.json', () => {
    const mismatches = versionSyncTest({
      srcDir: join(ROOT, 'src'),
      pkgPath: join(ROOT, 'package.json'),
    });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
