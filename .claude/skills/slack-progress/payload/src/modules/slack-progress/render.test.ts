import { describe, expect, it } from 'vitest';

import { renderPlainSummary, renderPlan, renderSummary, type ProgressRow } from './render.js';

function row(over: Partial<ProgressRow> = {}): ProgressRow {
  return {
    action: 'progress',
    turnId: 't1',
    platformId: 'slack:C1',
    threadId: 'slack:C1:1.1',
    todos: [],
    doing: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    elapsedMs: 42000,
    outcome: 'working',
    ...over,
  };
}

const three = [
  { title: 'First', status: 'completed' as const },
  { title: 'Second', status: 'in_progress' as const },
  { title: 'Third', status: 'pending' as const },
];

type Plan = { type: string; title: string; tasks: { task_id: string; title: string; status: string; details?: any }[] };
const planOf = (blocks: unknown[]) => blocks.find((b) => (b as { type: string }).type === 'plan') as Plan;
type Card = { type: string; task_id: string; title: string; status: string; details?: any };
const cardsOf = (blocks: unknown[]) => blocks.filter((b) => (b as { type: string }).type === 'task_card') as Card[];
const sections = (blocks: unknown[]) =>
  blocks
    .filter((b) => (b as { type: string }).type === 'section')
    .map((b) => (b as { text: { text: string } }).text.text);

const contexts = (blocks: unknown[]) =>
  blocks
    .filter((b) => (b as { type: string }).type === 'context')
    .map((b) => (b as { elements: { text: string }[] }).elements[0].text);

describe('renderPlan (working view)', () => {
  it('is one task card per step, pending ones included, with no title text and no plan block', () => {
    const { blocks } = renderPlan(row({ todos: three }));
    expect(blocks.every((b) => (b as { type: string }).type === 'task_card')).toBe(true);
    expect(cardsOf(blocks).map((c) => [c.title, c.status])).toEqual([
      ['First', 'complete'],
      ['Second', 'in_progress'],
      ['Third', 'pending'],
    ]);
    expect(cardsOf(blocks).map((c) => c.task_id)).toEqual(['t0', 't1', 't2']);
  });

  it('without pending support, waiting steps go in one small "Up next" line', () => {
    const { blocks } = renderPlan(row({ todos: three }), { pendingOk: false });
    expect(JSON.stringify(blocks)).not.toContain('"pending"');
    expect(cardsOf(blocks).map((c) => c.title)).toEqual(['First', 'Second']);
    expect(contexts(blocks)).toEqual(['Up next: Third']);
  });

  it('the fallback text names the step in progress', () => {
    expect(renderPlan(row({ todos: three, doing: 'Reading files' })).text).toBe('Working: Second');
  });

  it('doing appears as the in-progress card details', () => {
    const cs = cardsOf(renderPlan(row({ todos: three, doing: 'Reading files' })).blocks);
    expect(cs[1].details).toEqual({
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Reading files' }] }],
    });
    expect(cs[0].details).toBeUndefined();
    expect(cs[2].details).toBeUndefined();
  });

  it('no todos gives one in_progress card titled with the doing text, or Working', () => {
    const a = renderPlan(row({ doing: 'Searching the web' }));
    expect(a.blocks).toHaveLength(1);
    expect(cardsOf(a.blocks).map((c) => [c.title, c.status])).toEqual([['Searching the web', 'in_progress']]);
    expect(cardsOf(renderPlan(row()).blocks)[0].title).toBe('Working');
  });

  it('caps cards at 20, adds "and N more steps" and stays under 50 blocks', () => {
    const todos = Array.from({ length: 70 }, (_, i) => ({
      title: `Step ${i}`,
      status: i < 25 ? ('completed' as const) : ('pending' as const),
    }));
    const { blocks } = renderPlan(row({ todos }));
    expect(cardsOf(blocks)).toHaveLength(20);
    expect(contexts(blocks)).toContain('and 50 more steps');
    expect(blocks.length).toBeLessThan(50);
  });

  it('Up next line never splits an escape entity when trimmed', () => {
    const todos = [
      { title: 'Now', status: 'in_progress' as const },
      ...Array.from({ length: 80 }, (_, i) => ({ title: `${i} ${'&<>'.repeat(40)}`, status: 'pending' as const })),
    ];
    const next = contexts(renderPlan(row({ todos }), { pendingOk: false }).blocks).find((s) =>
      s.startsWith('Up next:'),
    )!;
    expect(next.length).toBeLessThanOrEqual(3000);
    expect(next).toMatch(/ and \d+ more$/);
    expect(next.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
  });

  it('<!channel>, <@U1> and & in titles render as typed', () => {
    const { text, blocks } = renderPlan(
      row({
        todos: [
          { title: 'now <!channel>', status: 'in_progress' },
          { title: 'ping <!channel> <@U1> & co', status: 'pending' },
        ],
        doing: 'ping <!channel> & <@U1>',
      }),
      { pendingOk: false },
    );
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
    const next = contexts(blocks).find((s) => s.startsWith('Up next:'))!;
    expect(next).toContain('&lt;@U1&gt;');
    expect(next).toContain('&amp;');
    expect(next).not.toContain('<@U1>');
  });
});

describe('renderPlainSummary', () => {
  it('is plain sections with no plan or card blocks', () => {
    const { text, blocks } = renderPlainSummary(row({ todos: three, outcome: 'done' }));
    expect(text.split('\n')[0]).toBe('Done in 42s, 3 steps');
    expect(blocks.map((b) => (b as { type: string }).type)).toEqual(['section']);
  });
});

describe('renderSummary', () => {
  it('summary text is "Done in 42s, 3 steps"', () => {
    const { text } = renderSummary(row({ todos: three, outcome: 'done' }));
    expect(text.split('\n')[0]).toBe('Done in 42s, 3 steps');
  });

  it('done with no todos has no placeholder card, error keeps one marked error', () => {
    const done = renderSummary(row({ outcome: 'done' }));
    expect(done.text).toBe('Done in 42s');
    expect(done.blocks).toEqual([]);
    const failed = renderSummary(row({ outcome: 'error' }));
    expect(planOf(failed.blocks).tasks.map((t) => t.status)).toEqual(['error']);
  });

  it('error outcome gives "Stopped after 42s" and marks the in-progress card error', () => {
    const { text, blocks } = renderSummary(row({ todos: three, outcome: 'error' }));
    expect(text.split('\n')[0]).toBe('Stopped after 42s');
    expect(planOf(blocks).tasks.map((t) => t.status)).toEqual(['complete', 'error', 'pending']);
  });

  it('keeps every step title readable, pending ones in a fallback section when pending is refused', () => {
    const plan = renderSummary(row({ todos: three, outcome: 'done' }));
    expect(planOf(plan.blocks).tasks.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
    const { blocks } = renderSummary(row({ todos: three, outcome: 'done' }), { pendingOk: false });
    expect(planOf(blocks).tasks.map((t) => t.title)).toEqual(['First', 'Second']);
    const section = blocks.find((b) => (b as { type: string }).type === 'section') as { text: { text: string } };
    expect(section.text.text).toContain('Third');
  });

  it("step titles in the summary stay within Slack's 3000-character text limit", () => {
    const todos = Array.from({ length: 60 }, (_, i) => ({
      title: `${i} ${'x'.repeat(500)}`,
      status: 'completed' as const,
    }));
    const { text } = renderSummary(row({ todos, outcome: 'done' }));
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.startsWith('Done in 42s, 60 steps')).toBe(true);
  });
});
