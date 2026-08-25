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
  });

  it('leaves the grant absent when the variable is unset', () => {
    expect(loadConfig({}).grant).toBeUndefined();
  });
});
