import { describe, expect, test } from 'bun:test';
import type { MessageInRow } from '../../db/messages-in.js';
import type { ProgressEvent } from '../../progress-seam.js';
import { createProgressTracker, type ProgressRow } from './tracker.js';

function setup(opts: { enabled?: boolean } = {}) {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const rows: ProgressRow[] = [];
  let n = 0;
  const tracker = createProgressTracker({
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { at: t + ms, fn, live: true };
      timers.push(e);
      return () => {
        e.live = false;
      };
    },
    send: (r) => rows.push(r),
    enabled: () => opts.enabled ?? true,
    newId: () => `turn-${++n}`,
  });
  function advance(ms: number) {
    const target = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      t = next.at;
      next.fn();
    }
    t = target;
  }
  return { tracker, rows, advance };
}

const start = (over: Record<string, unknown> = {}): ProgressEvent => ({
  type: 'turn_start',
  routing: {
    platformId: 'C1',
    channelType: 'slack',
    threadId: 'T1',
    inReplyTo: null,
    taskRun: false,
    ...over,
  },
  messages: [] as MessageInRow[],
});
const todos = (...s: ('pending' | 'in_progress' | 'completed')[]): ProgressEvent => ({
  type: 'todos',
  todos: s.map((status, i) => ({ content: `step ${i}`, status })),
});
const tool = (name = 'Read'): ProgressEvent => ({ type: 'tool', name, input: {} });

describe('progress tracker', () => {
  test('no row before 5000 ms without todos', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    tracker.onEvent(tool());
    advance(4999);
    expect(rows).toHaveLength(0);
  });

  test('first row at 5000 ms', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    tracker.onEvent(tool('Grep'));
    advance(5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'progress',
      platformId: 'C1',
      threadId: 'T1',
      doing: 'Searching files',
      outcome: 'working',
      elapsedMs: 5000,
    });
  });

  test('first TodoWrite sends a row at once', () => {
    const { tracker, rows } = setup();
    tracker.onEvent(start());
    tracker.onEvent(todos('in_progress', 'pending'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.todos).toHaveLength(2);
  });

  test('at most one row per 2000 ms, carrying the latest state', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    tracker.onEvent(todos('pending'));
    advance(500);
    tracker.onEvent(tool('Read'));
    advance(500);
    tracker.onEvent(tool('WebSearch'));
    expect(rows).toHaveLength(1);
    advance(1000);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.doing).toBe('Searching the web');
  });

  test('no row when nothing changed', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    advance(5000);
    expect(rows).toHaveLength(1);
    advance(20000);
    expect(rows).toHaveLength(1);
  });

  test('turn_end sends a final row with outcome done or error and elapsedMs', () => {
    for (const outcome of ['done', 'error'] as const) {
      const { tracker, rows, advance } = setup();
      tracker.onEvent(start());
      tracker.onEvent(todos('in_progress'));
      advance(300);
      tracker.onEvent({ type: 'turn_end', outcome });
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ outcome, elapsedMs: 300 });
    }
  });

  test('a turn that ends before 5000 ms with no todos sends nothing', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    advance(1000);
    tracker.onEvent({ type: 'turn_end', outcome: 'done' });
    advance(10000);
    expect(rows).toHaveLength(0);
  });

  test('todo content becomes title; status kept', () => {
    const { tracker, rows } = setup();
    tracker.onEvent(start());
    tracker.onEvent({ type: 'todos', todos: [{ content: 'Write it', status: 'completed', activeForm: 'Writing it' }] });
    expect(rows[0]!.todos).toEqual([{ title: 'Write it', status: 'completed' }]);
  });

  test('follow-up turn_start while a turn is open keeps the same turnId', () => {
    const { tracker, rows } = setup();
    tracker.onEvent(start());
    tracker.onEvent(start());
    tracker.onEvent(todos('pending'));
    expect(rows[0]!.turnId).toBe('turn-1');
  });

  test('repeated identical tools and to-do lists send no extra row', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    tracker.onEvent(todos('in_progress'));
    tracker.onEvent(tool('Read'));
    advance(2000);
    expect(rows).toHaveLength(2);
    for (let i = 0; i < 5; i++) {
      tracker.onEvent(tool('Read'));
      tracker.onEvent(todos('in_progress'));
      advance(2000);
    }
    expect(rows).toHaveLength(2);
  });

  test('turn_end with no open turn is ignored', () => {
    const { tracker, rows } = setup();
    tracker.onEvent({ type: 'turn_end', outcome: 'error' });
    expect(rows).toHaveLength(0);
  });

  test('task runs and non-slack channels are ignored', () => {
    const { tracker, rows } = setup();
    tracker.onEvent(start({ taskRun: true }));
    tracker.onEvent(todos('pending'));
    tracker.onEvent(start({ channelType: 'other' }));
    tracker.onEvent(todos('pending'));
    expect(rows).toHaveLength(0);
  });

  test('enabled() false sends nothing', () => {
    const { tracker, rows, advance } = setup({ enabled: false });
    tracker.onEvent(start());
    tracker.onEvent(todos('pending'));
    advance(6000);
    tracker.onEvent({ type: 'turn_end', outcome: 'done' });
    expect(rows).toHaveLength(0);
  });
});
