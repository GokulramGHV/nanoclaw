import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type CardTemplate,
  OldTemplateFormatError,
  TemplateError,
  escapeEntities,
  findTemplate,
  parseTemplate,
  validateData,
} from './template.js';

function tpl(over: Partial<CardTemplate> = {}): CardTemplate {
  return { version: 2, name: 'demo-request', data: {}, openui: 'demo-request.oui', ...over };
}

describe('escapeEntities', () => {
  it('escapes & < > in strings, arrays and objects, recursively', () => {
    expect(escapeEntities({ a: 'x & <y>', n: [{ b: '>' }, 'ok'], k: 1, t: true })).toEqual({
      a: 'x &amp; &lt;y&gt;',
      n: [{ b: '&gt;' }, 'ok'],
      k: 1,
      t: true,
    });
  });

  it('escapes the ampersand first, so an existing entity is escaped once more, not merged', () => {
    expect(escapeEntities('&lt;')).toBe('&amp;lt;');
  });

  it('leaves keys and non-strings alone and does not mutate the input', () => {
    const input = { 'a&b': 'x', list: ['<'] };
    escapeEntities(input);
    expect(input).toEqual({ 'a&b': 'x', list: ['<'] });
    expect(Object.keys(escapeEntities(input))).toEqual(['a&b', 'list']);
    expect(escapeEntities(null)).toBeNull();
  });
});

describe('validateData', () => {
  const t = tpl({
    data: {
      title: { type: 'string', required: true, maxLength: 5 },
      n: { type: 'number' },
      items: { type: 'array', maxItems: 2, items: { name: { type: 'string', required: true } } },
    },
  });

  it('accepts valid data', () => {
    expect(validateData(t, { title: 'abc', n: 1, items: [{ name: 'x' }] })).toEqual({
      title: 'abc',
      n: 1,
      items: [{ name: 'x' }],
    });
  });

  const problemsOf = (data: unknown): string[] => {
    try {
      validateData(t, data);
    } catch (err) {
      return (err as TemplateError).problems;
    }
    return [];
  };

  it('defaults array maxItems to 50', () => {
    const t2 = tpl({ data: { xs: { type: 'array', items: { a: { type: 'string' } } } } });
    expect(() => validateData(t2, { xs: Array.from({ length: 50 }, () => ({})) })).not.toThrow();
    expect(() => validateData(t2, { xs: Array.from({ length: 51 }, () => ({})) })).toThrow(/maxItems 50/);
  });

  it('lists an unknown key', () => expect(problemsOf({ title: 'a', extra: 1 })).toEqual(['unknown field "extra"']));
  it('lists a missing required field', () => expect(problemsOf({})).toEqual(['missing required field "title"']));
  it('lists a wrong type', () => expect(problemsOf({ title: 'a', n: 'x' })).toEqual(['field "n" must be a number']));
  it('lists maxLength exceeded', () =>
    expect(problemsOf({ title: 'abcdef' })).toEqual(['field "title" exceeds maxLength 5']));
  it('lists maxItems exceeded', () =>
    expect(problemsOf({ title: 'a', items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })).toEqual([
      'field "items" exceeds maxItems 2',
    ]));
  it('lists nested problems with paths', () =>
    expect(problemsOf({ title: 'a', items: [{ name: 'a' }, { x: 1 }] })).toEqual([
      'unknown field "items[1].x"',
      'missing required field "items[1].name"',
    ]));
  it('lists every problem at once', () => expect(problemsOf({ extra: 1, n: true })).toHaveLength(3));
});

describe('validateData arrays of strings and numbers', () => {
  const t = tpl({
    data: {
      labels: { type: 'array', of: 'string', maxItems: 3, maxLength: 5 },
      nums: { type: 'array', of: 'number' },
      objs: { type: 'array', items: { name: { type: 'string' } } },
    },
  });
  const problemsOf = (data: unknown): string[] => {
    try {
      validateData(t, data);
    } catch (err) {
      return (err as TemplateError).problems;
    }
    return [];
  };

  it('accepts string and number lists next to object lists', () => {
    expect(validateData(t, { labels: ['a', 'bb'], nums: [1, 2.5], objs: [{ name: 'x' }] })).toEqual({
      labels: ['a', 'bb'],
      nums: [1, 2.5],
      objs: [{ name: 'x' }],
    });
  });
  it('rejects mixed items with their path', () =>
    expect(problemsOf({ labels: ['a', 2, { x: 1 }], nums: [1, 'x'] })).toEqual([
      'field "labels[1]" must be a string',
      'field "labels[2]" must be a string',
      'field "nums[1]" must be a number',
    ]));
  it('rejects objects in a string list and strings in an object list', () => {
    expect(problemsOf({ objs: ['a'] })).toEqual(['objs[0] must be an object']);
  });
  it('keeps maxItems and the per-item maxLength', () => {
    expect(problemsOf({ labels: ['a', 'b', 'c', 'd'] })).toEqual(['field "labels" exceeds maxItems 3']);
    expect(problemsOf({ labels: ['abcdef'] })).toEqual(['field "labels[0]" exceeds maxLength 5']);
  });
  it('defaults string items to 3000 characters and the list to 50 items', () => {
    const t2 = tpl({ data: { xs: { type: 'array', of: 'string' } } });
    expect(() => validateData(t2, { xs: ['a'.repeat(3000)] })).not.toThrow();
    expect(() => validateData(t2, { xs: ['a'.repeat(3001)] })).toThrow(/maxLength 3000/);
    expect(() => validateData(t2, { xs: Array.from({ length: 51 }, () => 'a') })).toThrow(/maxItems 50/);
  });
  it('parseTemplate checks `of`', () => {
    const json = (data: unknown) => JSON.stringify({ version: 2, data, openui: 'x.oui' });
    expect(() => parseTemplate(json({ a: { type: 'array', of: 'string' } }), 'n')).not.toThrow();
    expect(() => parseTemplate(json({ a: { type: 'array', of: 'bool' } }), 'n')).toThrow(/of must be/);
    expect(() => parseTemplate(json({ a: { type: 'string', of: 'string' } }), 'n')).toThrow(/only applies to arrays/);
    expect(() => parseTemplate(json({ a: { type: 'array', of: 'string', items: {} } }), 'n')).toThrow(
      /both items and of/,
    );
  });
  it('escapes list strings like any other data', () => {
    expect(escapeEntities(validateData(t, { labels: ['a&<b'] }))).toEqual({ labels: ['a&amp;&lt;b'] });
  });
});

describe('parseTemplate', () => {
  const good = { version: 2, data: {}, openui: 'x.oui', access: { buttons: 'anyone' } };

  it('parses a good template and records the name', () => {
    const p = parseTemplate(JSON.stringify(good), 'demo-request');
    expect(p).toMatchObject({
      version: 2,
      name: 'demo-request',
      openui: 'x.oui',
      access: { buttons: 'anyone' },
    });
  });

  it('ignores a leftover text field and allows access to be left out', () => {
    const p = parseTemplate(JSON.stringify({ version: 2, openui: 'x.oui', text: 'old' }), 'x');
    expect(p).not.toHaveProperty('text');
    expect(p.access).toBeUndefined();
    expect(p.data).toEqual({});
  });

  it('refuses version 1 and no version as the old format, with the exact text', () => {
    const text = 'template x uses the old JSON block format; rewrite it in OpenUI Lang (see the slack-ui skill)';
    expect(() => parseTemplate(JSON.stringify({ version: 1, blocks: [] }), 'x')).toThrow(OldTemplateFormatError);
    expect(() => parseTemplate(JSON.stringify({ version: 1, blocks: [] }), 'x')).toThrow(text);
    expect(() => parseTemplate(JSON.stringify({ openui: 'x.oui' }), 'x')).toThrow(text);
  });

  it('rejects bad shapes', () => {
    expect(() => parseTemplate('nope', 'x')).toThrow(TemplateError);
    expect(() => parseTemplate('[]', 'x')).toThrow(/JSON object/);
    expect(() => parseTemplate(JSON.stringify({ ...good, version: 3 }), 'x')).toThrow(/version must be 2/);
    expect(() => parseTemplate(JSON.stringify({ ...good, data: { a: { type: 'date' } } }), 'x')).toThrow(/type/);
  });

  it.each([undefined, 5, '', 'x', 'x.txt', '../x.oui', 'a/b.oui', 'a\\b.oui', '.oui', '..oui/', '-x.oui'])(
    'rejects the openui value %j',
    (openui) => {
      expect(() => parseTemplate(JSON.stringify({ version: 2, openui }), 'x')).toThrow(
        /openui must be the plain file name/,
      );
    },
  );

  describe('access', () => {
    const parse = (access: unknown) => () => parseTemplate(JSON.stringify({ ...good, access }), 'x');

    it('accepts every rule shape, byId and lock', () => {
      expect(
        parse({
          default: 'owner',
          buttons: { group: 'S0EXAMPLE' },
          inputs: { users: ['U1', 'U2'] },
          feedback: 'anyone',
          forms: 'owner',
          byId: { ack: { group: 'S0EXAMPLE' }, other: 'anyone' },
          lock: { ids: ['ack'] },
        }),
      ).not.toThrow();
      expect(parse({ lock: 'never' })).not.toThrow();
      expect(parse({ lock: 'buttons' })).not.toThrow();
    });

    it('rejects an access that is not an object, an unknown key and bad rules', () => {
      expect(parse('anyone')).toThrow(/access must be an object/);
      expect(parse([])).toThrow(/access must be an object/);
      expect(parse({ extra: 'anyone' })).toThrow(/access\.extra is not a known setting/);
      expect(parse({ buttons: 'nobody' })).toThrow(/access\.buttons must be/);
      expect(parse({ buttons: { group: '' } })).toThrow(/access\.buttons must be/);
      expect(parse({ inputs: { users: [] } })).toThrow(/access\.inputs must be/);
      expect(parse({ inputs: { users: [1] } })).toThrow(/access\.inputs must be/);
      expect(parse({ forms: { group: 'S1', users: ['U1'] } })).toThrow(/access\.forms must be/);
      expect(parse({ byId: 'x' })).toThrow(/access\.byId must be an object/);
      expect(parse({ byId: { ack: 'nobody' } })).toThrow(/access\.byId\.ack must be/);
      expect(parse({ lock: 'always' })).toThrow(/access\.lock must be/);
      expect(parse({ lock: { ids: [1] } })).toThrow(/access\.lock must be/);
    });
  });
});

describe('findTemplate', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function group(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ui-tpl-'));
    dirs.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  }

  const body = JSON.stringify({ version: 2, data: {}, openui: 'demo-request.oui' });
  const oui = 'root = Root([])';

  it('finds a template under plugins/*/cards', async () => {
    const dir = group({
      'plugins/plugin-a/cards/demo-request.json': body,
      'plugins/plugin-a/cards/demo-request.oui': oui,
      'plugins/other/readme.md': 'x',
    });
    const found = await findTemplate(dir, 'demo-request');
    expect(found.path).toBe(path.join(dir, 'plugins/plugin-a/cards/demo-request.json'));
    expect(found.template.name).toBe('demo-request');
    expect(found.template.source).toBe(oui);
  });

  it('rejects names that are not slugs', async () => {
    const dir = group({});
    await expect(findTemplate(dir, '../x')).rejects.toThrow(TemplateError);
    await expect(findTemplate(dir, 'Bad')).rejects.toThrow(/invalid template name/);
  });

  it('errors on zero matches (with or without a plugins dir)', async () => {
    await expect(findTemplate(group({}), 'demo-request')).rejects.toThrow(/no card template/);
    await expect(findTemplate(group({ 'plugins/a/cards/other.json': body }), 'demo-request')).rejects.toThrow(
      /no card template/,
    );
  });

  it('errors when two plugins define the same name', async () => {
    const dir = group({
      'plugins/plugin-a/cards/demo-request.json': body,
      'plugins/plugin-a/cards/demo-request.oui': oui,
      'plugins/plugin-b/cards/demo-request.json': body,
      'plugins/plugin-b/cards/demo-request.oui': oui,
    });
    const err = await findTemplate(dir, 'demo-request').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).toMatch(/ambiguous/);
    expect(err.message).toContain('plugin-a');
    expect(err.message).toContain('plugin-b');
    expect(err.message).not.toContain(dir);
  });

  it('refuses a version 1 template with the exact text and no plugin suffix', async () => {
    const dir = group({ 'plugins/p/cards/old.json': JSON.stringify({ version: 1, text: 't', blocks: [] }) });
    const err = await findTemplate(dir, 'old').catch((e) => e);
    expect(err).toBeInstanceOf(OldTemplateFormatError);
    expect(err.message).toBe(
      'template old uses the old JSON block format; rewrite it in OpenUI Lang (see the slack-ui skill)',
    );
  });

  it('errors, without an absolute path, when the .oui file is missing', async () => {
    const dir = group({ 'plugins/p/cards/no-src.json': JSON.stringify({ version: 2, openui: 'no-src.oui' }) });
    const err = await findTemplate(dir, 'no-src').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).toMatch(/cannot read no-src\.oui/);
    expect(err.message).not.toContain(dir);
  });

  it('only reads the .oui file beside the template, never another folder', async () => {
    const dir = group({
      'plugins/p/cards/x.json': JSON.stringify({ version: 2, openui: '../secret.oui' }),
      'plugins/p/secret.oui': 'root = Root([])',
    });
    await expect(findTemplate(dir, 'x')).rejects.toThrow(/openui must be the plain file name/);
  });

  it('refuses a .oui file that is a symlink, with a plain error', async () => {
    const dir = group({
      'plugins/p/cards/ln.json': JSON.stringify({ version: 2, openui: 'ln.oui' }),
      'elsewhere.txt': 'root = Root([])',
    });
    fs.symlinkSync(path.join(dir, 'elsewhere.txt'), path.join(dir, 'plugins/p/cards/ln.oui'));
    const err = await findTemplate(dir, 'ln').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).toBe('ln.oui of card template "ln" must not be a symlink');
    expect(err.message).not.toContain(dir);
  });

  it('refuses a template .json that is a symlink', async () => {
    const dir = group({
      'real.json': JSON.stringify({ version: 2, openui: 'sl.oui' }),
      'plugins/p/cards/sl.oui': 'root = Root([])',
    });
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'plugins/p/cards/sl.json'));
    const err = await findTemplate(dir, 'sl').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).toBe('card template "sl" in plugin "p" must not be a symlink');
  });

  it('wraps read and parse failures in TemplateError without absolute paths', async () => {
    const dir = group({ 'plugins/p/cards/bad-json.json': '{nope' });
    fs.mkdirSync(path.join(dir, 'plugins/p/cards/a-dir.json'), { recursive: true });
    for (const n of ['bad-json', 'a-dir']) {
      const err = await findTemplate(dir, n).catch((e) => e);
      expect(err).toBeInstanceOf(TemplateError);
      expect(err.message).not.toContain(dir);
    }
  });

  it('keeps the original error as cause, including for bad JSON', async () => {
    const dir = group({ 'plugins/p/cards/bad-json.json': '{nope' });
    const err = await findTemplate(dir, 'bad-json').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.cause).toBeInstanceOf(SyntaxError);
    fs.mkdirSync(path.join(dir, 'plugins/p/cards/a-dir.json'));
    const err2 = await findTemplate(dir, 'a-dir').catch((e) => e);
    expect(err2.cause).toBeInstanceOf(Error);
  });

  it('wraps a plugins/ listing failure without an absolute path', async () => {
    const dir = group({ plugins: 'not a directory' });
    const err = await findTemplate(dir, 'demo-request').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).not.toContain(dir);
    expect(err.cause).toBeInstanceOf(Error);
  });
});
