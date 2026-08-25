/**
 * Where the skills come from, and the precedence between the two names.
 *
 * `MCP_SKILLS_PATH` is what mcp-host's runner injects and is RESERVED there;
 * `SKILLS_DIR` is the local-use name. The hosted one wins, so a value a
 * registration's plain `env` supplies can never shadow the one the host
 * computed — the direction matters, because re-pointing the adapter aims it at
 * any directory on the machine.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig, defaultSkillsDir } from '../src/config.js';

describe('loadConfig', () => {
  it('prefers the host-injected MCP_SKILLS_PATH over SKILLS_DIR', () => {
    const config = loadConfig({ MCP_SKILLS_PATH: '/slots/a', SKILLS_DIR: '/home/me/skills' });
    expect(config.roots).toEqual(['/slots/a']);
    expect(config.rootsFrom).toBe('MCP_SKILLS_PATH');
  });

  it('splits a colon-separated list, in order', () => {
    const config = loadConfig({ MCP_SKILLS_PATH: '/slots/a:/slots/b' });
    expect(config.roots).toEqual(['/slots/a', '/slots/b']);
  });

  it('falls back to SKILLS_DIR when nothing is injected', () => {
    const config = loadConfig({ SKILLS_DIR: '/home/me/skills' });
    expect(config.roots).toEqual(['/home/me/skills']);
    expect(config.rootsFrom).toBe('SKILLS_DIR');
  });

  it("defaults to this package's own skills directory", () => {
    const config = loadConfig({});
    expect(config.rootsFrom).toBe('default');
    expect(config.roots).toEqual([defaultSkillsDir()]);
    expect(config.roots[0]).toBe(join(defaultSkillsDir()));
  });

  it('treats a blank or placeholder value as unset', () => {
    expect(loadConfig({ MCP_SKILLS_PATH: '   ', SKILLS_DIR: '/x' }).rootsFrom).toBe('SKILLS_DIR');
    expect(loadConfig({ MCP_SKILLS_PATH: '${MCP_SKILLS_PATH}' }).rootsFrom).toBe('default');
  });

  it('turns an unreadable grant into an EMPTY grant plus an error, never into no grant at all', () => {
    const config = loadConfig({ MCP_SKILL_RUN: '{not json' });
    expect(config.grant?.entries).toEqual([]);
    expect(config.grantError).toMatch(/MCP_SKILL_RUN/);
    expect(config.grantFrom).toBe('MCP_SKILL_RUN');
  });

  it('leaves the grant absent when nothing is injecting the roots', () => {
    const config = loadConfig({});
    expect(config.grant).toBeUndefined();
    expect(config.grantFrom).toBe('declaration');
  });

  it('reads the grant when it is set', () => {
    const config = loadConfig({ MCP_SKILL_RUN: '[{"skill":"a","script":"s.js"}]' });
    expect(config.grant?.entries).toHaveLength(1);
    expect(config.grantFrom).toBe('MCP_SKILL_RUN');
  });

  /*
   * The default is per CALLER, and the hosted half is fail-CLOSED.
   *
   * docs/SKILL-MCP.md §7: "Empty by default. A registration created without
   * this field executes nothing." When a runner is injecting the roots there IS
   * a registration and an owner behind this child, so an absent grant means the
   * owner granted nothing — not that the skill's own frontmatter decides. One
   * child holds one environment holding every credential the owner set, so
   * skill A's frontmatter naming skill B's variable is exactly the failure the
   * grant exists to prevent, and whoever writes mcp-host's write path must not
   * be able to forget the variable and get a silently wider server.
   *
   * Standalone use keeps declaration-stands: nothing is injecting anything, the
   * person who pointed the server at a directory is the owner, and an empty
   * default there would make `npx @chrischall/skill-mcp` do nothing at all.
   */
  it('grants NOTHING by default when the roots were injected by a host', () => {
    const config = loadConfig({ MCP_SKILLS_PATH: '/slots/a' });
    expect(config.grant?.entries).toEqual([]);
    expect(config.grantFrom).toBe('hosted-default');
    expect(config.grantError).toBeUndefined();
  });

  it('lets the declaration stand for a standalone SKILLS_DIR run', () => {
    const config = loadConfig({ SKILLS_DIR: '/home/me/skills' });
    expect(config.grant).toBeUndefined();
    expect(config.grantFrom).toBe('declaration');
  });

  it('lets an explicit grant win over the hosted default, in both directions', () => {
    const wider = loadConfig({
      MCP_SKILLS_PATH: '/slots/a',
      MCP_SKILL_RUN: '[{"skill":"a","script":"s.js"}]',
    });
    expect(wider.grantFrom).toBe('MCP_SKILL_RUN');
    expect(wider.grant?.entries).toHaveLength(1);

    // An explicitly empty grant is still explicitly empty, not the default.
    expect(loadConfig({ MCP_SKILLS_PATH: '/slots/a', MCP_SKILL_RUN: '[]' }).grantFrom).toBe(
      'MCP_SKILL_RUN',
    );
  });
});
