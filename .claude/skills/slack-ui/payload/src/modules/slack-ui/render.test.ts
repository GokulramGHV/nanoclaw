import { describe, expect, it } from 'vitest';

import type { UiCard } from './db/ui-cards.js';
import {
  applyState,
  lockedBlocks,
  mergeState,
  parseActionId,
  renderCard,
  stateFromPayload,
  withActionIds,
} from './render.js';
import { TemplateError, type CardTemplate } from './template.js';

const opt = (v: string, t = v) => ({ text: { type: 'plain_text', text: t }, value: v });

function pickBlocks(): unknown[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: 'hello' } },
    {
      type: 'actions',
      elements: [
        { type: 'checkboxes', action_id: 'pick', options: [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')] },
        { type: 'button', action_id: 'create', text: { type: 'plain_text', text: 'Create' } },
      ],
    },
  ];
}

describe('action ids', () => {
  it('rewrites and parses round-trip', () => {
    const out = withActionIds(pickBlocks(), 'card1') as any[];
    expect(out[1].elements[0].action_id).toBe('ncu:card1:pick');
    expect(out[1].elements[1].action_id).toBe('ncu:card1:create');
    expect(parseActionId('ncu:card1:pick')).toEqual({ cardId: 'card1', control: 'pick' });
  });

  it('rewrites section accessory ids', () => {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'x' }, accessory: { type: 'button', action_id: 'go' } },
    ];
    expect((withActionIds(blocks, 'c') as any[])[0].accessory.action_id).toBe('ncu:c:go');
  });

  it('does not mutate its input', () => {
    const blocks = pickBlocks();
    const snap = JSON.stringify(blocks);
    withActionIds(blocks, 'c');
    expect(JSON.stringify(blocks)).toBe(snap);
  });

  it('rejects foreign or malformed ids', () => {
    expect(parseActionId('ncq:x:0')).toBeNull();
    expect(parseActionId('ncu:')).toBeNull();
    expect(parseActionId('ncu:x')).toBeNull();
    expect(parseActionId('ncu:x:')).toBeNull();
    expect(parseActionId('ncu::pick')).toBeNull();
    expect(parseActionId('pick')).toBeNull();
  });

  it('keeps colons inside the control', () => {
    expect(parseActionId('ncu:c:a:b')).toEqual({ cardId: 'c', control: 'a:b' });
  });
});

describe('stateFromPayload', () => {
  it('reads a two-option checkbox payload', () => {
    const raw = {
      state: {
        values: { b1: { 'ncu:c:pick': { type: 'checkboxes', selected_options: [{ value: 'a' }, { value: 'b' }] } } },
      },
      actions: [{ action_id: 'ncu:c:pick', type: 'checkboxes', selected_options: [{ value: 'a' }, { value: 'b' }] }],
    };
    expect(stateFromPayload(raw)).toEqual({ pick: ['a', 'b'] });
  });

  it('a button press yields no state for buttons', () => {
    expect(stateFromPayload({ state: {}, actions: [{ action_id: 'ncu:c:create', type: 'button' }] })).toEqual({});
  });

  it('empty or missing selected_options gives an empty array', () => {
    expect(
      stateFromPayload({ actions: [{ action_id: 'ncu:c:pick', type: 'checkboxes', selected_options: [] }] }),
    ).toEqual({ pick: [] });
    expect(stateFromPayload({ actions: [{ action_id: 'ncu:c:pick', type: 'checkboxes' }] })).toEqual({ pick: [] });
  });

  it('reads selects, radios and text inputs; skips null select', () => {
    const raw = {
      state: {
        values: {
          b: {
            'ncu:c:sel': { type: 'static_select', selected_option: { value: 'x' } },
            'ncu:c:rad': { type: 'radio_buttons', selected_option: { value: 'y' } },
            'ncu:c:txt': { type: 'plain_text_input', value: 'hi' },
            'ncu:c:none': { type: 'static_select', selected_option: null },
            'ncu:c:empty': { type: 'plain_text_input', value: null },
            'ncu:c:multi': { type: 'multi_static_select', selected_options: [{ value: 'm' }] },
          },
        },
      },
    };
    expect(stateFromPayload(raw)).toEqual({ sel: 'x', rad: 'y', txt: 'hi', empty: '', multi: ['m'] });
  });

  it('actions override state.values', () => {
    const raw = {
      state: { values: { b: { 'ncu:c:pick': { type: 'checkboxes', selected_options: [{ value: 'a' }] } } } },
      actions: [{ action_id: 'ncu:c:pick', type: 'checkboxes', selected_options: [] }],
    };
    expect(stateFromPayload(raw)).toEqual({ pick: [] });
  });

  it('ignores foreign ids', () => {
    const raw = { actions: [{ action_id: 'ncq:x:0', type: 'checkboxes', selected_options: [{ value: 'a' }] }] };
    expect(stateFromPayload(raw)).toEqual({});
  });

  it('never throws on malformed input', () => {
    for (const raw of [
      null,
      undefined,
      5,
      'x',
      [],
      {},
      { state: 1 },
      { state: { values: 3 } },
      { state: { values: { b: null } } },
      { actions: 'x' },
      { actions: [null, 1, {}] },
      { actions: [{ action_id: 5 }] },
      { state: { values: { b: { 'ncu:c:p': { type: 'checkboxes', selected_options: 'zz' } } } } },
    ]) {
      expect(() => stateFromPayload(raw)).not.toThrow();
    }
    expect(stateFromPayload(null)).toEqual({});
    expect(stateFromPayload({ actions: [null, 1, {}] })).toEqual({});
  });
});

describe('mergeState', () => {
  it('keeps stored values when the payload omits a control', () => {
    expect(
      mergeState(
        { pick: ['a'] },
        stateFromPayload({ state: {}, actions: [{ action_id: 'ncu:c:create', type: 'button' }] }),
      ),
    ).toEqual({ pick: ['a'] });
  });
  it('payload overrides, including an empty selection', () => {
    expect(mergeState({ pick: ['a'] }, { pick: [] })).toEqual({ pick: [] });
    expect(mergeState({ pick: ['a'], t: 'x' }, { pick: ['b'] })).toEqual({ pick: ['b'], t: 'x' });
  });
});

describe('applyState', () => {
  it('sets initial_options to only the chosen options, in options order', () => {
    const blocks = withActionIds(pickBlocks(), 'c');
    const out = applyState(blocks, { pick: ['c', 'a', 'zzz'] }) as any[];
    const el = out[1].elements[0];
    expect(el.initial_options).toEqual([opt('a', 'Alpha'), opt('c', 'Gamma')]);
    expect(el.initial_options[0]).toBe(el.options[0]);
  });

  it('deletes initial_options when nothing matches', () => {
    const blocks = pickBlocks() as any[];
    blocks[1].elements[0].initial_options = [opt('a', 'Alpha')];
    const out = applyState(blocks, { pick: [] }) as any[];
    expect('initial_options' in out[1].elements[0]).toBe(false);
    const out2 = applyState(blocks, { pick: ['nope'] }) as any[];
    expect('initial_options' in out2[1].elements[0]).toBe(false);
  });

  it('leaves controls absent from state alone', () => {
    const blocks = pickBlocks() as any[];
    blocks[1].elements[0].initial_options = [opt('b', 'Beta')];
    const out = applyState(blocks, {}) as any[];
    expect(out[1].elements[0].initial_options).toEqual([opt('b', 'Beta')]);
  });

  it('handles selects, radios and text inputs', () => {
    const blocks = [
      {
        type: 'actions',
        elements: [
          { type: 'static_select', action_id: 'sel', options: [opt('x'), opt('y')] },
          { type: 'radio_buttons', action_id: 'rad', options: [opt('p'), opt('q')], initial_option: opt('p') },
          { type: 'plain_text_input', action_id: 'txt' },
        ],
      },
    ];
    const out = applyState(blocks, { sel: 'y', rad: 'nope', txt: 'hello' }) as any[];
    expect(out[0].elements[0].initial_option).toBe(out[0].elements[0].options[1]);
    expect('initial_option' in out[0].elements[1]).toBe(false);
    expect(out[0].elements[2].initial_value).toBe('hello');
  });

  it('ignores non-string and non-string-array state values', () => {
    const blocks = pickBlocks() as any[];
    blocks[1].elements[0].initial_options = [opt('b', 'Beta')];
    const out = applyState(blocks, { pick: 5 as any }) as any[];
    expect(out[1].elements[0].initial_options).toEqual([opt('b', 'Beta')]);
    const out2 = applyState(blocks, { pick: [1, 'a'] as any }) as any[];
    expect(out2[1].elements[0].initial_options).toEqual([opt('b', 'Beta')]);
  });

  it('applies to accessory elements and does not mutate input', () => {
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'x' },
        accessory: { type: 'multi_static_select', action_id: 'ncu:c:m', options: [opt('a'), opt('b')] },
      },
    ];
    const snap = JSON.stringify(blocks);
    const out = applyState(blocks, { m: ['b'] }) as any[];
    expect(out[0].accessory.initial_options).toEqual([opt('b')]);
    expect(JSON.stringify(blocks)).toBe(snap);
  });
});

describe('lockedBlocks', () => {
  const at = new Date('2026-01-02T03:04:05.000Z');

  it('drops actions blocks and lists the chosen items', () => {
    const blocks = withActionIds(pickBlocks(), 'c');
    const out = lockedBlocks(blocks, { pick: ['b', 'a'] }, 'Submitted', 'U1', at) as any[];
    expect(out.some((b) => b.type === 'actions')).toBe(false);
    expect(out[0].text.text).toBe('hello');
    expect(out[1]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*Chosen (2):* Alpha, Beta' } });
    expect(out[2]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Submitted by <@U1> at <!date^1767323045^{time_secs}|${at.toISOString()}>` }],
    });
  });

  it('says none when nothing is chosen', () => {
    const out = lockedBlocks(pickBlocks(), { pick: [] }, 'Submitted', 'U1', at) as any[];
    expect(out[1].text.text).toBe('*Chosen (0):* none');
  });

  it('escapes chosen text and the label', () => {
    const blocks = [
      { type: 'actions', elements: [{ type: 'checkboxes', action_id: 'p', options: [opt('a', '<b> & @here')] }] },
    ];
    const out = lockedBlocks(blocks, { p: ['a'] }, 'A<B', 'U1', at) as any[];
    expect(out[0].text.text).toContain('&lt;b&gt; &amp; @⁠here');
    expect(out[1].elements[0].text.startsWith('A&lt;B by')).toBe(true);
  });

  it('omits "by" when userId is empty', () => {
    const out = lockedBlocks([], {}, 'Submitted', '', at) as any[];
    expect(out[0].elements[0].text).toBe(`Submitted at <!date^1767323045^{time_secs}|${at.toISOString()}>`);
  });

  it('removes section accessories, adding a Chosen line for a checkbox accessory', () => {
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'a' },
        accessory: { type: 'button', action_id: 'go', text: { type: 'plain_text', text: 'Go' } },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'b' },
        accessory: { type: 'checkboxes', action_id: 'p', options: [opt('x', 'X'), opt('y', 'Y')] },
      },
    ];
    const out = lockedBlocks(blocks, { p: ['y'] }, 'Submitted', 'U1', at) as any[];
    expect(out.every((b) => !('accessory' in b))).toBe(true);
    expect(out[0].text.text).toBe('a');
    expect(out[1].text.text).toBe('b');
    expect(out[2].text.text).toBe('*Chosen (1):* Y');
    expect(out[3].type).toBe('context');
  });

  it('does not mutate its input', () => {
    const blocks = pickBlocks();
    const snap = JSON.stringify(blocks);
    lockedBlocks(blocks, { pick: ['a'] }, 'Submitted', 'U1', at);
    expect(JSON.stringify(blocks)).toBe(snap);
  });
});

describe('lockedBlocks limits', () => {
  const at = new Date('2026-01-02T03:04:05.000Z');
  const multi = (id: string, n: number, len = 10) => ({
    type: 'actions',
    elements: [
      {
        type: 'checkboxes',
        action_id: id,
        options: Array.from({ length: n }, (_, i) => opt(`v${i}`, `${'x'.repeat(len)}${i}`)),
      },
    ],
  });

  it('caps a Chosen line at 3000 chars, ending with an ellipsis', () => {
    const blocks = [multi('p', 10, 500)];
    const state = { p: Array.from({ length: 10 }, (_, i) => `v${i}`) };
    const out = lockedBlocks(blocks, state, 'Submitted', 'U1', at) as any[];
    expect(out[0].text.text.length).toBeLessThanOrEqual(3000);
    expect(out[0].text.text.endsWith('\u2026')).toBe(true);
  });

  it('merges Chosen lines when over 50 blocks, and keeps context last', () => {
    const sections = Array.from({ length: 45 }, (_, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `s${i}` },
    }));
    const blocks = [
      ...sections,
      multi('a', 2),
      multi('b', 2),
      multi('c', 2),
      multi('d', 2),
      multi('e', 2),
      multi('f', 2),
    ];
    const state = { a: ['v0'], b: ['v1'], c: ['v0'], d: ['v1'], e: ['v0'], f: ['v1'] };
    const out = lockedBlocks(blocks, state, 'Submitted', 'U1', at) as any[];
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out[out.length - 1].type).toBe('context');
    expect(out.filter((b) => b.text?.text?.startsWith('*Chosen')).length).toBe(1);
    expect(JSON.stringify(out)).toContain('*Chosen (1):*');
    expect(out.some((b) => (b.text?.text ?? '').includes('\n'))).toBe(true);
  });

  it('drops trailing content blocks when still over 50, keeping context last', () => {
    const sections = Array.from({ length: 70 }, (_, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `s${i}` },
    }));
    const out = lockedBlocks(sections, {}, 'Submitted', 'U1', at) as any[];
    expect(out.length).toBe(50);
    expect(out[48].text.text).toBe('s48');
    expect(out[49].type).toBe('context');
  });
});

describe('stateFromPayload unsafe controls', () => {
  it('skips __proto__, constructor and prototype', () => {
    const mk = (c: string) => ({ action_id: `ncu:c:${c}`, type: 'plain_text_input', value: 'x' });
    const raw = { actions: [mk('__proto__'), mk('constructor'), mk('prototype'), mk('ok')] };
    const out = stateFromPayload(raw);
    expect(Object.keys(out)).toEqual(['ok']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as any).x).toBeUndefined();
  });
});

describe('renderCard', () => {
  const template: CardTemplate = {
    version: 1,
    name: 'demo-request',
    text: 'Pick {{title}}',
    data: { title: { type: 'string' }, items: { type: 'array', items: { name: { type: 'string' } } } },
    controls: { create: { who: 'owner', submit: true } },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*{{title}}*' } },
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
                do: { text: { type: 'plain_text', text: '{{it.name}}' }, value: '{{it.name}}' },
              },
            ],
          },
          { type: 'button', action_id: 'create', text: { type: 'plain_text', text: 'Create' } },
        ],
      },
    ],
  };
  const card = (over: Partial<UiCard> = {}): UiCard => ({
    id: 'c1',
    agentGroupId: 'g',
    sessionId: 's',
    instance: 'slack',
    channelId: 'C1',
    threadTs: null,
    messageTs: null,
    ownerUserId: 'U1',
    templateName: 'demo-request',
    template,
    data: { title: 'T', items: [{ name: 'a' }, { name: 'b' }] },
    state: { pick: ['b'] },
    locked: false,
    lockedBy: null,
    lockedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('fills, rewrites ids and applies state', () => {
    const { text, blocks } = renderCard(card()) as { text: string; blocks: any[] };
    expect(text).toBe('Pick T');
    expect(blocks[1].elements[0].action_id).toBe('ncu:c1:pick');
    expect(blocks[1].elements[1].action_id).toBe('ncu:c1:create');
    expect(blocks[1].elements[0].initial_options.map((o: any) => o.value)).toEqual(['b']);
  });

  // Seen live: after a refused untick, the redraw with identical blocks left
  // the presser's local tick on their screen. A fresh block_id per render makes
  // Slack draw the stored state instead.
  it('gives every block a fresh, unique block_id on each render, keeping a template block_id as prefix', () => {
    const withId: CardTemplate = {
      ...template,
      blocks: [{ ...(template.blocks[0] as object), block_id: 'head' }, template.blocks[1]],
    };
    const first = renderCard(card({ template: withId })).blocks as any[];
    const second = renderCard(card({ template: withId })).blocks as any[];
    const ids = first.map((b) => b.block_id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 255)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0].startsWith('head.')).toBe(true);
    expect(second.map((b) => b.block_id)).not.toEqual(ids);
  });

  it('renders the locked view with lockedBy and lockedAt', () => {
    const { blocks } = renderCard(card({ locked: true, lockedBy: 'U2', lockedAt: '2026-01-02T03:04:05.000Z' })) as {
      blocks: any[];
    };
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(blocks)).toContain('*Chosen (1):* b');
    expect(JSON.stringify(blocks)).toContain(
      'Submitted by <@U2> at <!date^1767323045^{time_secs}|2026-01-02T03:04:05.000Z>',
    );
  });

  it('escapes option text once in the locked view, whether mrkdwn or plain', () => {
    const mixed: CardTemplate = {
      ...template,
      blocks: [
        {
          type: 'actions',
          elements: [
            {
              type: 'checkboxes',
              action_id: 'pick',
              options: [
                { $each: 'items', as: 'it', do: { text: { type: 'mrkdwn', text: '{{it.name}}' }, value: 'm' } },
                { text: { type: 'plain_text', text: 'C & D' }, value: 'p' },
              ],
            },
          ],
        },
      ],
    };
    const { blocks } = renderCard(
      card({ template: mixed, data: { items: [{ name: 'A & B' }] }, state: { pick: ['m', 'p'] }, locked: true }),
    ) as { blocks: any[] };
    const json = JSON.stringify(blocks);
    expect(json).toContain('*Chosen (2):* A &amp; B, C &amp; D');
    expect(json).not.toContain('&amp;amp;');
  });

  it('lets TemplateError propagate', () => {
    expect(() =>
      renderCard(card({ template: { ...template, text: 'x', blocks: new Array(60).fill({ type: 'divider' }) } })),
    ).toThrow(TemplateError);
  });
});
