import { describe, expect, it } from 'vitest';

import { renderPlan, renderSummary, type ProgressRow } from './render.js';

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

describe('renderPlan', () => {
  it('todos become task_cards with statuses pending/in_progress/complete', () => {
    const { blocks } = renderPlan(row({ todos: three }), { pendingOk: true });
    const plan = planOf(blocks);
    expect(plan.tasks.map((t) => [t.title, t.status])).toEqual([
      ['First', 'complete'],
      ['Second', 'in_progress'],
      ['Third', 'pending'],
    ]);
    expect(new Set(plan.tasks.map((t) => t.task_id)).size).toBe(3);
  });

  it('doing appears as the in-progress card details', () => {
    const plan = planOf(renderPlan(row({ todos: three, doing: 'Reading files' }), { pendingOk: true }).blocks);
    expect(plan.tasks[1].details).toEqual({
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Reading files' }] }],
    });
    expect(plan.tasks[0].details).toBeUndefined();
  });

  it('no todos gives a single card with only the doing line', () => {
    const plan = planOf(renderPlan(row({ doing: 'Searching the web' }), { pendingOk: true }).blocks);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].title).toBe('Searching the web');
    expect(plan.tasks[0].status).toBe('in_progress');
  });

  it('pendingOk false removes pending cards and lists them in a section', () => {
    const { blocks } = renderPlan(row({ todos: three }), { pendingOk: false });
    expect(planOf(blocks).tasks.map((t) => t.status)).toEqual(['complete', 'in_progress']);
    const section = blocks.find((b) => (b as { type: string }).type === 'section') as { text: { text: string } };
    expect(section.text.text).toContain('Third');
  });

  it('<!channel>, <@U1> and & in titles render as typed', () => {
    const { text, blocks } = renderPlan(
      row({ todos: [{ title: 'ping <!channel> <@U1> & co', status: 'pending' }], doing: 'ping <!channel> & <@U1>' }),
      { pendingOk: false },
    );
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).toContain('&amp;');
    expect(text).not.toContain('<!channel>');
    const section = blocks.find((b) => (b as { type: string }).type === 'section') as { text: { text: string } };
    expect(section.text.text).toContain('&lt;@U1&gt;');
    expect(section.text.text).not.toContain('<@U1>');
  });
});

describe('renderSummary', () => {
  it('summary text is "Done in 42s, 3 steps"', () => {
    const { text } = renderSummary(row({ todos: three, outcome: 'done' }));
    expect(text.split('\n')[0]).toBe('Done in 42s, 3 steps');
  });

  it('error outcome gives "Stopped after 42s" and marks the in-progress card error', () => {
    const { text, blocks } = renderSummary(row({ todos: three, outcome: 'error' }));
    expect(text.split('\n')[0]).toBe('Stopped after 42s');
    expect(planOf(blocks).tasks.map((t) => t.status)).toEqual(['complete', 'error']);
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
