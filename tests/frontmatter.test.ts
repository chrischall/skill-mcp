/**
 * Frontmatter reading. The adapter's copy of a SKILL.md is the PINNED one (it
 * came out of the bundle the registration named), so this reader's job is to
 * be exact and to fail per-file rather than per-listing — not to defend a
 * Worker's heap, which is the gateway's preview read (docs/SKILL-MCP.md §3.2).
 * The YAML posture of §7.1 is still applied: 1.2 core schema, no aliases, a
 * size cap, unknown major refused, unknown keys reported by name.
 */
import { describe, it, expect } from 'vitest';
import { FrontmatterError, parseSkillMd, readDeclaration } from '../src/frontmatter.js';

const doc = (fm: string, body = 'Body text.\n'): string => `---\n${fm}\n---\n${body}`;

describe('parseSkillMd', () => {
  it('splits frontmatter from the body and keeps the body VERBATIM', () => {
    const parsed = parseSkillMd(doc('name: demo\ndescription: A demo skill.', '# Demo\n\n---\nnot frontmatter\n'));
    expect(parsed.frontmatter).toEqual({ name: 'demo', description: 'A demo skill.' });
    expect(parsed.body).toBe('# Demo\n\n---\nnot frontmatter\n');
  });

  it('refuses a file with no frontmatter at all', () => {
    expect(() => parseSkillMd('# Just markdown\n')).toThrow(FrontmatterError);
  });

  it('refuses an unterminated frontmatter block', () => {
    expect(() => parseSkillMd('---\nname: demo\n')).toThrow(FrontmatterError);
  });

  it('reports the parser position on malformed YAML', () => {
    try {
      parseSkillMd(doc('name: [unclosed'));
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterError);
      expect((err as Error).message).toMatch(/line|column|\d/);
    }
  });

  it('refuses YAML anchors and aliases', () => {
    expect(() => parseSkillMd(doc('a: &x hello\nb: *x'))).toThrow(FrontmatterError);
  });

  it('refuses a frontmatter block over the cap', () => {
    expect(() => parseSkillMd(doc(`name: demo\nnote: ${'x'.repeat(70_000)}`))).toThrow(
      FrontmatterError,
    );
  });

  it('refuses frontmatter that is not a mapping', () => {
    expect(() => parseSkillMd(doc('- one\n- two'))).toThrow(FrontmatterError);
  });
});

describe('readDeclaration', () => {
  it('reads name, description and when-to-use', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'Does a thing.',
      'when-to-use': 'When a thing needs doing.',
    });
    expect(d.name).toBe('demo');
    expect(d.description).toBe('Does a thing.');
    expect(d.whenToUse).toBe('When a thing needs doing.');
    expect(d.run).toEqual([]);
    expect(d.problems).toEqual([]);
  });

  it('reads the mcp-host run block', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'x',
      'mcp-host': {
        version: 1,
        run: [{ script: 'scripts/go.js', interpreter: 'node', env: ['DEMO_TOKEN'], timeout: 30 }],
        egress: ['api.example.com'],
      },
    });
    expect(d.run).toEqual([
      { script: 'scripts/go.js', interpreter: 'node', env: ['DEMO_TOKEN'], timeoutMs: 30_000 },
    ]);
    expect(d.egress).toEqual(['api.example.com']);
  });

  it('refuses an unknown MAJOR version of the block outright', () => {
    const d = readDeclaration({ name: 'demo', description: 'x', 'mcp-host': { version: 2, run: [{ script: 'a.js', interpreter: 'node' }] } });
    expect(d.run).toEqual([]);
    expect(d.problems.join(' ')).toMatch(/version 2/);
  });

  it('reports unknown keys by NAME instead of ignoring them silently', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'x',
      'mcp-host': { version: 1, runn: [] },
    });
    expect(d.problems.join(' ')).toMatch(/runn/);
  });

  it('drops a run entry whose script is not a string, naming it', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'x',
      'mcp-host': { version: 1, run: [{ script: 1.1, interpreter: 'node' }] },
    });
    expect(d.run).toEqual([]);
    expect(d.problems.join(' ')).toMatch(/script/);
  });

  it('drops a run entry whose declared path is not contained', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'x',
      'mcp-host': { version: 1, run: [{ script: '../../etc/passwd', interpreter: 'node' }] },
    });
    expect(d.run).toEqual([]);
    expect(d.problems.join(' ')).toMatch(/\.\./);
  });

  it('caps a declared timeout at the hard ceiling and reports it', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'x',
      'mcp-host': { version: 1, run: [{ script: 'a.js', interpreter: 'node', timeout: 9999 }] },
    });
    expect(d.run[0]?.timeoutMs).toBe(300_000);
    expect(d.problems.join(' ')).toMatch(/timeout/);
  });

  it('strips a reserved host variable out of a script env request, naming it', () => {
    const d = readDeclaration({
      name: 'demo',
      description: 'x',
      'mcp-host': {
        version: 1,
        run: [{ script: 'a.js', interpreter: 'node', env: ['OK_VAR', 'MCP_SKILLS_PATH'] }],
      },
    });
    expect(d.run[0]?.env).toEqual(['OK_VAR']);
    expect(d.problems.join(' ')).toMatch(/MCP_SKILLS_PATH/);
  });

  it('keeps a declaration for an interpreter this deployment cannot run', () => {
    // Reported, not silently dropped: the refusal belongs to skill_run, which
    // names the interpreter and this deployment's set (§6.1).
    const d = readDeclaration({
      name: 'docx',
      description: 'x',
      'mcp-host': { version: 1, run: [{ script: 'ooxml/unpack.py', interpreter: 'python3' }] },
    });
    expect(d.run).toEqual([
      { script: 'ooxml/unpack.py', interpreter: 'python3', env: [], timeoutMs: 60_000 },
    ]);
  });
});
