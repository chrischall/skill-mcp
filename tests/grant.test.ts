/**
 * The owner's grant.
 *
 * docs/SKILL-MCP.md §7 puts the authority on the REGISTRATION: the skill's own
 * declaration narrows, the owner grants, and the stored row is what the adapter
 * reads. SKILL-1's design does not name the channel that carries the row to the
 * child (only `MCP_SKILLS_PATH` is specified), so this adapter reads an
 * optional `MCP_SKILL_RUN` and — the property that makes an unspecified
 * channel safe — treats it as NARROW-ONLY: present means the declaration
 * intersected with it, and there is no spelling of this variable that makes
 * something runnable which the skill did not declare, so an owner who sets it in
 * a registration's plain `env` can only ever reduce what runs.
 *
 * What an ABSENT variable means is `config.ts`'s decision and is tested there:
 * the EMPTY grant when a host injected the roots (§7's "empty by default", which
 * is a statement about a registration), the declaration when somebody ran this
 * from a terminal. The functions below are the mechanism for both.
 */
import { describe, it, expect } from 'vitest';
import { GrantError, parseGrant, applyGrant } from '../src/grant.js';
import type { Catalog } from '../src/discovery.js';

const catalog = (): Catalog => ({
  roots: ['/slots/a'],
  skills: [
    {
      name: 'weather',
      dir: '/slots/a/weather',
      root: '/slots/a',
      body: 'x',
      bodyTruncated: false,
      files: [],
      scripts: [
        { script: 'scripts/forecast.js', interpreter: 'node', env: ['WEATHER_API_KEY', 'EXTRA'], timeoutMs: 60_000 },
        { script: 'scripts/geocode.js', interpreter: 'node', env: [], timeoutMs: 60_000 },
      ],
      declaration: {
        run: [
          { script: 'scripts/forecast.js', interpreter: 'node', env: ['WEATHER_API_KEY', 'EXTRA'], timeoutMs: 60_000 },
          { script: 'scripts/geocode.js', interpreter: 'node', env: [], timeoutMs: 60_000 },
        ],
        env: [],
        egress: [],
        problems: [],
      },
    },
  ],
  problems: [],
});

describe('parseGrant', () => {
  it('is absent when the variable is unset or blank', () => {
    expect(parseGrant(undefined)).toBeUndefined();
    expect(parseGrant('   ')).toBeUndefined();
  });

  it('reads a list of skill/script/env rows', () => {
    const grant = parseGrant('[{"skill":"weather","script":"scripts/forecast.js","env":["WEATHER_API_KEY"]}]');
    expect(grant?.entries).toEqual([
      { skill: 'weather', script: 'scripts/forecast.js', env: ['WEATHER_API_KEY'] },
    ]);
  });

  it('refuses malformed JSON rather than silently granting everything', () => {
    expect(() => parseGrant('{not json')).toThrow(GrantError);
  });

  it('refuses a row that is not a skill/script pair', () => {
    expect(() => parseGrant('[{"skill":"weather"}]')).toThrow(GrantError);
  });

  it('accepts an empty list, which grants nothing', () => {
    expect(parseGrant('[]')?.entries).toEqual([]);
  });
});

describe('applyGrant', () => {
  it('leaves the declaration alone when there is no grant', () => {
    const applied = applyGrant(catalog(), undefined);
    expect(applied.skills[0]?.scripts.map((s) => s.script)).toEqual([
      'scripts/forecast.js',
      'scripts/geocode.js',
    ]);
  });

  it('keeps only the declared scripts the grant names', () => {
    const applied = applyGrant(
      catalog(),
      parseGrant('[{"skill":"weather","script":"scripts/geocode.js"}]'),
    );
    expect(applied.skills[0]?.scripts.map((s) => s.script)).toEqual(['scripts/geocode.js']);
  });

  it('intersects the env request with the grant, never unions it', () => {
    const applied = applyGrant(
      catalog(),
      parseGrant(
        '[{"skill":"weather","script":"scripts/forecast.js","env":["WEATHER_API_KEY","NEIGHBOUR_KEY"]}]',
      ),
    );
    expect(applied.skills[0]?.scripts[0]?.env).toEqual(['WEATHER_API_KEY']);
  });

  it('cannot make a script runnable that the skill never declared', () => {
    const applied = applyGrant(
      catalog(),
      parseGrant('[{"skill":"weather","script":"scripts/evil.js"}]'),
    );
    expect(applied.skills[0]?.scripts).toEqual([]);
    expect(applied.problems.find((p) => p.reason === 'grant')?.detail).toContain('scripts/evil.js');
  });

  it('keys the grant on the skill DIRECTORY, not on any name a skill could choose', () => {
    // Discovery already serves a skill under its directory name, so these two
    // agree in practice. This is the second line: the grant is matched against
    // the path on disk, so a change that let frontmatter influence `name`
    // again could not re-open the impersonation (docs/SKILL-MCP.md §2.1, §7).
    const impostor = catalog();
    impostor.skills[0]!.name = 'weather';
    impostor.skills[0]!.dir = '/slots/a/aaa';

    const applied = applyGrant(
      impostor,
      parseGrant('[{"skill":"weather","script":"scripts/geocode.js"}]'),
    );
    expect(applied.skills[0]?.scripts).toEqual([]);
    expect(applied.problems.find((p) => p.reason === 'grant')).toBeDefined();

    const honest = applyGrant(
      impostor,
      parseGrant('[{"skill":"aaa","script":"scripts/geocode.js"}]'),
    );
    expect(honest.skills[0]?.scripts.map((s) => s.script)).toEqual(['scripts/geocode.js']);
  });

  it('an empty grant makes the registration execute nothing', () => {
    const applied = applyGrant(catalog(), parseGrant('[]'));
    expect(applied.skills[0]?.scripts).toEqual([]);
  });

  it('leaves the declaration itself readable, so skill_list can show what was NOT granted', () => {
    const applied = applyGrant(
      catalog(),
      parseGrant('[{"skill":"weather","script":"scripts/geocode.js"}]'),
    );
    expect(applied.skills[0]?.declaration.run).toHaveLength(2);
  });
});
