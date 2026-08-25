/**
 * Packaging invariants that otherwise only fail once a tag exists.
 *
 * `npm publish --provenance` validates the sigstore bundle against
 * `repository.url` and rejects the WHOLE publish without it — after
 * release-please has already tagged and cut the GitHub Release, so the release
 * looks green while npm never moves. Guarding it here costs a test; finding it
 * on a tag costs a wasted version.
 *
 * The name split is the fleet's rule and is easy to half-apply: unscoped
 * `skill-mcp` is taken on npm, so the PACKAGE is scoped — and only the
 * npm-publish identity takes the scope. The bin, the registry name and the
 * plugin names stay unscoped so the whole identity is one word.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import { registerSkillTools } from '../src/tools/skills.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>;

const pkg = read('package.json');
const manifest = read('manifest.json');
const serverJson = read('server.json');
const plugin = read('.claude-plugin/plugin.json');
const marketplace = read('.claude-plugin/marketplace.json');

describe('package.json', () => {
  it('declares the repository npm provenance validates against', () => {
    expect((pkg.repository as { url?: string }).url).toBe(
      'git+https://github.com/chrischall/skill-mcp.git',
    );
  });

  it('is published under the scope, with public access', () => {
    expect(pkg.name).toBe('@chrischall/skill-mcp');
    expect((pkg.publishConfig as { access?: string }).access).toBe('public');
  });

  it('keeps the bin, the registry name and the plugin name UNSCOPED', () => {
    expect(Object.keys(pkg.bin as object)).toEqual(['skill-mcp']);
    expect(pkg.mcpName).toBe('io.github.chrischall/skill-mcp');
    expect(serverJson.name).toBe('io.github.chrischall/skill-mcp');
    expect(plugin.name).toBe('skill-mcp');
  });

  it('ships the skills directory, which is this server\'s default content', () => {
    expect(pkg.files).toContain('skills/');
  });

  it('points its single bin at dist/index.js, which tsconfig rootDir makes true', () => {
    expect((pkg.bin as Record<string, string>)['skill-mcp']).toBe('dist/index.js');
  });
});

describe('versions agree across every manifest', () => {
  it('package.json, manifest.json, server.json and the plugin manifests match', () => {
    const version = pkg.version;
    expect(manifest.version).toBe(version);
    expect(serverJson.version).toBe(version);
    expect((serverJson.packages as { version: string }[])[0]?.version).toBe(version);
    expect(plugin.version).toBe(version);
    expect((marketplace.metadata as { version: string }).version).toBe(version);
    expect((marketplace.plugins as { version: string }[])[0]?.version).toBe(version);
  });
});

describe('registry constraints', () => {
  it("server.json's description is inside the registry's 100-char cap", () => {
    expect((serverJson.description as string).length).toBeLessThanOrEqual(100);
  });
});

describe("manifest.json's tool roster", () => {
  it('equals the registered roster in BOTH directions, with no blank descriptions', async () => {
    const deps = await createDeps({ SKILLS_DIR: join(ROOT, 'skills') });
    const harness = await createTestHarness((server) => registerSkillTools(server, deps));
    try {
      const registered = (await harness.listTools()).map((t) => t.name).sort();
      const declared = (manifest.tools as { name: string; description: string }[]);
      expect(declared.map((t) => t.name).sort()).toEqual(registered);
      for (const tool of declared) expect(tool.description.trim().length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });
});
