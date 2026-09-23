/**
 * The exec-time environment block is wiped at boot (chrischall/fleet-audit#244).
 *
 * A declared script runs as this server's uid, and Linux lets a same-uid
 * process read `/proc/<ppid>/environ` — the server's ORIGINAL exec-time
 * environment, every credential the registration holds. The unit tests drive
 * the logic through an injected io; the last test does it for real, on Linux
 * only, by asking a grandchild to read its parent's environ.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvRange, scrubExecEnvironment, type ScrubIo } from '../src/scrub-environ.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A `/proc/self/stat` line with env_start/env_end at fields 50/51. */
function statLine(envStart: number, envEnd: number, comm = 'node'): string {
  // Fields 3..49 are filler; 50 and 51 are env_start / env_end; 52 is exit_code.
  const rest = Array.from({ length: 47 }, (_, i) => String(i + 3));
  return `4242 (${comm}) S ${rest.slice(1).join(' ')} ${envStart} ${envEnd} 0\n`;
}

function fakeIo(overrides: Partial<ScrubIo> = {}): { io: ScrubIo; log: string[] } {
  const log: string[] = [];
  const store: Record<string, string> = { SECRET_KEY: 'sk-123', PATH: '/usr/bin' };
  const env = new Proxy(store, {
    set(target, key, value) {
      log.push(`set ${String(key)}`);
      target[key as string] = value as string;
      return true;
    },
  }) as NodeJS.ProcessEnv;
  const io: ScrubIo = {
    platform: 'linux',
    env,
    readStat: () => statLine(1000, 1064),
    writeMem: (offset, bytes) => {
      log.push(`write ${offset} ${bytes.length} ${bytes.every((b) => b === 0) ? 'zeros' : 'data'}`);
    },
    readEnviron: () => Buffer.alloc(64),
    ...overrides,
  };
  return { io, log };
}

describe('parseEnvRange', () => {
  it('reads env_start and env_end (fields 50 and 51)', () => {
    expect(parseEnvRange(statLine(140737488350000, 140737488351234))).toEqual({
      start: 140737488350000,
      end: 140737488351234,
    });
  });

  it('counts fields after the LAST ")", so a comm with spaces and parens cannot shift them', () => {
    expect(parseEnvRange(statLine(10, 20, 'no de) (x y'))).toEqual({ start: 10, end: 20 });
  });

  it('refuses a line too short to carry the fields (kernels before 3.5)', () => {
    expect(parseEnvRange('1 (node) S 1 2 3\n')).toBeUndefined();
  });

  it('refuses an empty or inverted range', () => {
    expect(parseEnvRange(statLine(0, 0))).toBeUndefined();
    expect(parseEnvRange(statLine(20, 10))).toBeUndefined();
  });
});

describe('scrubExecEnvironment', () => {
  it('does nothing off Linux', () => {
    const { io, log } = fakeIo({ platform: 'darwin' });
    expect(scrubExecEnvironment(io)).toEqual({ status: 'unsupported' });
    expect(log).toEqual([]);
  });

  it('re-homes every variable BEFORE zeroing the block, then zeroes exactly env_start..env_end', () => {
    const { io, log } = fakeIo();
    expect(scrubExecEnvironment(io)).toEqual({ status: 'scrubbed', bytes: 64 });
    expect(log).toEqual(['set SECRET_KEY', 'set PATH', 'write 1000 64 zeros']);
    // The values themselves survive: process.env is what scripts are built from.
    expect(io.env.SECRET_KEY).toBe('sk-123');
    expect(io.env.PATH).toBe('/usr/bin');
  });

  it('reports failure when the block still reads back non-empty', () => {
    const { io } = fakeIo({ readEnviron: () => Buffer.from('SECRET_KEY=sk-123\0') });
    expect(scrubExecEnvironment(io)).toMatchObject({ status: 'failed' });
  });

  it('never throws: an unwritable /proc/self/mem is a reported failure', () => {
    const { io } = fakeIo({
      writeMem: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(scrubExecEnvironment(io)).toEqual({ status: 'failed', reason: 'EACCES: permission denied' });
    expect(io.env.SECRET_KEY).toBe('sk-123');
  });

  it('never throws: an unparseable stat line is a reported failure and writes nothing', () => {
    const { io, log } = fakeIo({ readStat: () => 'garbage' });
    expect(scrubExecEnvironment(io)).toMatchObject({ status: 'failed' });
    expect(log.some((entry) => entry.startsWith('write'))).toBe(false);
  });
});

describe.runIf(process.platform === 'linux')('on a real Linux kernel', () => {
  it("a child can no longer read the server's credentials from /proc/<ppid>/environ", () => {
    const source = join(ROOT, 'src', 'scrub-environ.ts');
    const program = `
      const { scrubExecEnvironment } = await import(${JSON.stringify(source)});
      const outcome = scrubExecEnvironment();
      const { spawnSync } = await import('node:child_process');
      const peek = spawnSync('sh', ['-c', 'cat /proc/$PPID/environ'], { env: { PATH: process.env.PATH } });
      process.stdout.write(JSON.stringify({
        outcome,
        stillInProcessEnv: process.env.FLEET_AUDIT_244,
        leaked: peek.stdout.toString('latin1').includes('sentinel-244'),
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      env: { PATH: process.env.PATH, FLEET_AUDIT_244: 'sentinel-244' },
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as {
      outcome: { status: string };
      stillInProcessEnv: string;
      leaked: boolean;
    };
    expect(report.outcome.status).toBe('scrubbed');
    expect(report.stillInProcessEnv).toBe('sentinel-244');
    expect(report.leaked).toBe(false);
  });
});
