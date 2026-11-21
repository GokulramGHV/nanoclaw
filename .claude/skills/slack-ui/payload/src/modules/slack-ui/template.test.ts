import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type CardTemplate,
  TemplateError,
  escapeMrkdwn,
  fillTemplate,
  findTemplate,
  parseTemplate,
  validateData,
} from './template.js';

function tpl(over: Partial<CardTemplate> = {}): CardTemplate {
  return { version: 1, name: 'demo-request', text: 'hi', data: {}, controls: {}, blocks: [], ...over };
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

describe('fillTemplate', () => {
  it('expands $each into options with substituted values', () => {
    const t = tpl({
      blocks: [
        {
          type: 'actions',
          elements: [
            {
              type: 'checkboxes',
              action_id: 'pick',
              options: [
                {
                  $each: 'items',
                  as: 'it',
                  do: { text: { type: 'plain_text', text: '{{it.name}} ({{it.count}})' }, value: '{{it.name}}' },
                },
              ],
            },
          ],
        },
      ],
    });
    const out = fillTemplate(t, { items: [{ name: 'a', count: 2 }, { name: 'b' }] });
    const opts = ((out.blocks[0] as any).elements[0] as any).options;
    expect(opts).toEqual([
      { text: { type: 'plain_text', text: 'a (2)' }, value: 'a' },
      { text: { type: 'plain_text', text: 'b ()' }, value: 'b' },
    ]);
    expect(out.initialState).toEqual({});
  });

  it('supports nested $each', () => {
    const t = tpl({
      blocks: [
        {
          $each: 'groups',
          as: 'g',
          do: {
            type: 'section',
            fields: [{ $each: 'g.rows', as: 'r', do: { type: 'mrkdwn', text: '{{g.title}}:{{r.v}}' } }],
          },
        },
      ],
    });
    const out = fillTemplate(t, {
      groups: [
        { title: 'x', rows: [{ v: '1' }, { v: '2' }] },
        { title: 'y', rows: [{ v: '3' }] },
      ],
    });
    expect((out.blocks as any[]).map((b) => b.fields.map((f: any) => f.text))).toEqual([['x:1', 'x:2'], ['y:3']]);
  });

  it('turns $selected into initial_options and initialState, dropping the key', () => {
    const t = tpl({
      blocks: [
        {
          type: 'actions',
          elements: [
            {
              type: 'checkboxes',
              action_id: 'pick',
              options: [
                {
                  $each: 'items',
                  as: 'it',
                  do: {
                    text: { type: 'plain_text', text: '{{it.name}}' },
                    value: '{{it.name}}',
                    $selected: 'it.selected',
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const out = fillTemplate(t, {
      items: [
        { name: 'a', selected: true },
        { name: 'b', selected: false },
        { name: 'c', selected: true },
      ],
    });
    const el = (out.blocks[0] as any).elements[0];
    expect(el.options).toHaveLength(3);
    expect(el.initial_options.map((o: any) => o.value)).toEqual(['a', 'c']);
    expect(JSON.stringify(out.blocks)).not.toContain('$selected');
    expect(out.initialState).toEqual({ pick: ['a', 'c'] });
  });

  it('records an empty state when nothing is selected, and omits initial_options', () => {
    const t = tpl({
      blocks: [
        {
          type: 'actions',
          elements: [
            {
              type: 'checkboxes',
              action_id: 'pick',
              options: [{ text: { type: 'plain_text', text: 'x' }, value: 'x', $selected: 'missing.path' }],
            },
          ],
        },
      ],
    });
    const out = fillTemplate(t, {});
    expect((out.blocks[0] as any).elements[0].initial_options).toBeUndefined();
    expect(out.initialState).toEqual({ pick: [] });
  });

  it('escapes substituted values in mrkdwn and fallback text only', () => {
    const t = tpl({
      text: 'T {{v}}',
      blocks: [
        section('*{{v}}* <b>'),
        { type: 'header', text: { type: 'plain_text', text: '{{v}}' } },
        {
          type: 'actions',
          elements: [{ type: 'button', action_id: 'go', text: { type: 'plain_text', text: 'Go' }, value: '{{v}}' }],
        },
      ],
    });
    const v = '<!channel> & @here @HERE <@U1>';
    const out = fillTemplate(t, { v });
    const escaped = '&lt;!channel&gt; &amp; @\u2060here @\u2060HERE &lt;@U1&gt;';
    expect((out.blocks[0] as any).text.text).toBe(`*${escaped}* <b>`);
    expect((out.blocks[1] as any).text.text).toBe(v);
    expect((out.blocks[2] as any).elements[0].value).toBe(v);
    expect(out.text).toBe(`T ${escaped}`);
    expect(escapeMrkdwn(v)).toBe(escaped);
  });

  it('escapes substituted values in markdown blocks', () => {
    const out = fillTemplate(tpl({ blocks: [{ type: 'markdown', text: 'x {{v}}' }] }), { v: '<!channel>' });
    expect((out.blocks[0] as any).text).toBe('x &lt;!channel&gt;');
  });

  it('caps markdown block text at 12000 characters', () => {
    const md = () => tpl({ blocks: [{ type: 'markdown', text: '{{v}}' }] });
    expect(() => fillTemplate(md(), { v: 'x'.repeat(12000) })).not.toThrow();
    expect(() => fillTemplate(md(), { v: 'x'.repeat(12001) })).toThrow(/12001/);
  });

  it('removes the block holding an empty text, and cascades to emptied containers', () => {
    const t = tpl({
      blocks: [
        section('{{a}}'),
        section('keep'),
        {
          type: 'actions',
          elements: [
            {
              type: 'checkboxes',
              action_id: 'pick',
              options: [
                { $each: 'items', as: 'it', do: { text: { type: 'plain_text', text: '{{it.name}}' }, value: 'v' } },
              ],
            },
          ],
        },
        { type: 'section', fields: [{ type: 'mrkdwn', text: '{{a}}' }] },
      ],
    });
    const out = fillTemplate(t, { a: '  ', items: [{ name: '' }] });
    expect(out.blocks).toEqual([section('keep')]);
  });

  it('removes only the empty field and keeps the rest of a section', () => {
    const t = tpl({
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'hello' },
          fields: [
            { type: 'mrkdwn', text: '{{a}}' },
            { type: 'mrkdwn', text: '{{b}}' },
          ],
        },
      ],
    });
    const out = fillTemplate(t, { a: '', b: 'B' });
    expect((out.blocks[0] as any).fields).toEqual([{ type: 'mrkdwn', text: 'B' }]);
  });

  it('uses the template name when the filled fallback text is empty', () => {
    const out = fillTemplate(tpl({ text: '{{t}}' }), { t: '' });
    expect(out.text).toBe('demo-request');
  });

  it('does not mutate the template', () => {
    const t = tpl({ blocks: [section('{{v}}')] });
    const before = JSON.stringify(t);
    fillTemplate(t, { v: 'x' });
    expect(JSON.stringify(t)).toBe(before);
  });

  it('rejects over-limit output', () => {
    expect(() => fillTemplate(tpl({ blocks: Array.from({ length: 51 }, () => section('x')) }), {})).toThrow(
      TemplateError,
    );
    expect(() => fillTemplate(tpl({ blocks: [section('{{v}}')] }), { v: 'x'.repeat(3001) })).toThrow(/3001/);
    const boxes = {
      type: 'actions',
      elements: [
        {
          type: 'checkboxes',
          action_id: 'p',
          options: Array.from({ length: 11 }, (_, i) => ({
            text: { type: 'plain_text', text: `o${i}` },
            value: `${i}`,
          })),
        },
      ],
    };
    expect(() => fillTemplate(tpl({ blocks: [boxes] }), {})).toThrow(/checkbox/);
    const buttons = {
      type: 'actions',
      elements: Array.from({ length: 26 }, (_, i) => ({
        type: 'button',
        action_id: `b${i}`,
        text: { type: 'plain_text', text: 'b' },
      })),
    };
    expect(() => fillTemplate(tpl({ blocks: [buttons] }), {})).toThrow(/actions block/);
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

describe('parseTemplate', () => {
  const good = { version: 1, text: 't', data: {}, controls: { go: { who: 'owner', submit: true } }, blocks: [] };

  it('parses a good template and records the name', () => {
    const p = parseTemplate(JSON.stringify(good), 'demo-request');
    expect(p.name).toBe('demo-request');
    expect(p.controls.go.submit).toBe(true);
  });

  it('rejects bad shapes', () => {
    expect(() => parseTemplate('nope', 'x')).toThrow(TemplateError);
    expect(() => parseTemplate(JSON.stringify({ ...good, version: 2 }), 'x')).toThrow(/version/);
    expect(() => parseTemplate(JSON.stringify({ ...good, blocks: {} }), 'x')).toThrow(/blocks/);
    expect(() => parseTemplate(JSON.stringify({ ...good, controls: { a: { who: 'nobody' } } }), 'x')).toThrow(/who/);
    expect(() => parseTemplate(JSON.stringify({ ...good, data: { a: { type: 'date' } } }), 'x')).toThrow(/type/);
    expect(() => parseTemplate(JSON.stringify({ ...good, blocks: [{ $each: 'a' }] }), 'x')).toThrow(/\$each/);
  });

  it('rejects an action_id that takes a value from data', () => {
    const button = (id: string) => ({ type: 'button', action_id: id, text: { type: 'plain_text', text: 'B' } });
    const top = { ...good, blocks: [{ type: 'actions', elements: [button('go-{{name}}')] }] };
    expect(() => parseTemplate(JSON.stringify(top), 'x')).toThrow(TemplateError);
    expect(() => parseTemplate(JSON.stringify(top), 'x')).toThrow(
      'template "x": blocks[0].elements[0].action_id must be a fixed string, not filled from data',
    );
    const each = {
      ...good,
      data: { items: { type: 'array', items: { id: { type: 'string' } } } },
      blocks: [{ type: 'actions', elements: [{ $each: 'items', as: 'it', do: button('{{ it.id }}') }] }],
    };
    expect(() => parseTemplate(JSON.stringify(each), 'x')).toThrow(/blocks\[0\]\.elements\[0\]\.do\.action_id/);
    const fixed = { ...good, blocks: [{ type: 'actions', elements: [button('go')] }] };
    expect(() => parseTemplate(JSON.stringify(fixed), 'x')).not.toThrow();
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

  const body = JSON.stringify({ version: 1, text: 't', blocks: [] });

  it('finds a template under plugins/*/cards', async () => {
    const dir = group({ 'plugins/plugin-a/cards/demo-request.json': body, 'plugins/other/readme.md': 'x' });
    const found = await findTemplate(dir, 'demo-request');
    expect(found.path).toBe(path.join(dir, 'plugins/plugin-a/cards/demo-request.json'));
    expect(found.template.name).toBe('demo-request');
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
      'plugins/plugin-b/cards/demo-request.json': body,
    });
    const err = await findTemplate(dir, 'demo-request').catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).toMatch(/ambiguous/);
    expect(err.message).toContain('plugin-a');
    expect(err.message).toContain('plugin-b');
    expect(err.message).not.toContain(dir);
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
