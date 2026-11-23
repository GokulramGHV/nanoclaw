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

/** The context row the host writes before an engaged message when it shows a plan for the chat. */
const DISPLAY_ROW = { id: 's1:wake-context:slack-progress:display:m1' } as MessageInRow;

const start = (over: Record<string, unknown> = {}, messages: MessageInRow[] = [DISPLAY_ROW]): ProgressEvent => ({
  type: 'turn_start',
  routing: {
    platformId: 'C1',
    channelType: 'slack',
    threadId: 'T1',
    inReplyTo: null,
    taskRun: false,
    ...over,
  },
  messages,
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

  test('no tool and no todos past 5000 ms emits nothing, even at turn end', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    advance(8000);
    expect(rows).toHaveLength(0);
    tracker.onEvent({ type: 'turn_end', outcome: 'done' });
    expect(rows).toHaveLength(0);
  });

  test('a tool call made after 5000 ms emits a row at once', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    advance(6000);
    expect(rows).toHaveLength(0);
    tracker.onEvent(tool('Read'));
    expect(rows).toHaveLength(1);
  });

  test('no row when nothing changed', () => {
    const { tracker, rows, advance } = setup();
    tracker.onEvent(start());
    tracker.onEvent(tool());
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

  test('malformed todos are coerced so the row stays valid', () => {
    const { tracker, rows } = setup();
    tracker.onEvent(start());
    tracker.onEvent({
      type: 'todos',
      todos: [{ status: 'in_progress' }, { content: 'ok', status: 'weird' }, null] as never,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].todos).toEqual([
      { title: '', status: 'in_progress' },
      { title: 'ok', status: 'pending' },
      { title: '', status: 'pending' },
    ]);
  });

  describe('task tools', () => {
    const create = (subject: string): ProgressEvent => ({ type: 'tool', name: 'TaskCreate', input: { subject } });
    const update = (taskId: string, status: string, extra: Record<string, unknown> = {}): ProgressEvent => ({
      type: 'tool',
      name: 'TaskUpdate',
      input: { taskId, status, ...extra },
    });

    test('TaskCreate and TaskUpdate build steps and show the plan at once', () => {
      const { tracker, rows } = setup();
      tracker.onEvent(start());
      tracker.onEvent(create('a'));
      expect(rows).toHaveLength(1);
      tracker.onEvent(create('b'));
      tracker.onEvent(create('c'));
      tracker.onEvent(update('1', 'in_progress'));
      tracker.onEvent(update('1', 'completed'));
      tracker.onEvent(update('2', 'in_progress'));
      tracker.onEvent({ type: 'turn_end', outcome: 'done' });
      expect(rows[rows.length - 1]!.todos).toEqual([
        { title: 'a', status: 'completed' },
        { title: 'b', status: 'in_progress' },
        { title: 'c', status: 'pending' },
      ]);
      expect(rows[rows.length - 1]!.doing).toBeNull();
    });

    test('deleted removes a step and a subject change renames it', () => {
      const { tracker, rows } = setup();
      tracker.onEvent(start());
      tracker.onEvent(create('a'));
      tracker.onEvent(create('b'));
      tracker.onEvent(update('1', 'deleted'));
      tracker.onEvent(update('2', 'in_progress', { subject: 'b2' }));
      tracker.onEvent({ type: 'turn_end', outcome: 'done' });
      expect(rows[rows.length - 1]!.todos).toEqual([{ title: 'b2', status: 'in_progress' }]);
    });

    test('steps from an earlier turn appear when updated later', () => {
      const { tracker, rows } = setup();
      tracker.onEvent(start());
      tracker.onEvent(create('a'));
      tracker.onEvent(create('b'));
      tracker.onEvent({ type: 'turn_end', outcome: 'done' });
      tracker.onEvent(start());
      tracker.onEvent(update('2', 'completed'));
      tracker.onEvent({ type: 'turn_end', outcome: 'done' });
      expect(rows[rows.length - 1]!.todos).toEqual([{ title: 'b', status: 'completed' }]);
    });

    describe('real ids from TaskCreate results', () => {
      const createId = (subject: string, id: string): ProgressEvent => ({
        type: 'tool',
        name: 'TaskCreate',
        input: { subject },
        id,
      });
      const result = (id: string, text: string): ProgressEvent => ({ type: 'tool_result', id, text });
      const created = (n: string, subject = 'x') => `Task #${n} created successfully: ${subject}`;
      const last = (rows: ProgressRow[]) => rows[rows.length - 1]!.todos;

      test('ids from results re-key steps, so updates by real id hit the right step', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(createId('a', 'u1'));
        tracker.onEvent(createId('b', 'u2'));
        tracker.onEvent(result('u1', created('7', 'a')));
        tracker.onEvent(result('u2', created('8', 'b')));
        tracker.onEvent(update('8', 'completed'));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(rows)).toEqual([
          { title: 'a', status: 'pending' },
          { title: 'b', status: 'completed' },
        ]);
      });

      test('restart-like: counter at 0, SDK ids start at 4', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(createId('a', 'u1'));
        tracker.onEvent(createId('b', 'u2'));
        tracker.onEvent(result('u1', created('4')));
        tracker.onEvent(result('u2', created('5')));
        tracker.onEvent(update('4', 'in_progress'));
        tracker.onEvent(update('1', 'completed'));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(rows)).toEqual([
          { title: 'a', status: 'in_progress' },
          { title: 'b', status: 'pending' },
        ]);
        // the counter stays above the real ids
        const { tracker: t2, rows: r2 } = setup();
        t2.onEvent(start());
        t2.onEvent(createId('a', 'u1'));
        t2.onEvent(result('u1', created('4')));
        t2.onEvent(create('b'));
        t2.onEvent(update('5', 'completed'));
        t2.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(r2)).toEqual([
          { title: 'a', status: 'pending' },
          { title: 'b', status: 'completed' },
        ]);
      });

      test('an unparseable result falls back to the counter id', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(createId('a', 'u1'));
        tracker.onEvent(result('u1', 'something else'));
        tracker.onEvent(result('unknown', created('9')));
        tracker.onEvent(update('1', 'completed'));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(rows)).toEqual([{ title: 'a', status: 'completed' }]);
      });

      test('a result id that is another waiting step`s counter id swaps cleanly', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(createId('a', 'u1'));
        tracker.onEvent(createId('b', 'u2'));
        tracker.onEvent(result('u1', created('2')));
        tracker.onEvent(result('u2', created('1')));
        tracker.onEvent(update('2', 'completed'));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(rows)).toEqual([
          { title: 'a', status: 'completed' },
          { title: 'b', status: 'pending' },
        ]);
      });

      test('after a restart, a TaskCreate and a TaskUpdate for an old id in one batch do not cross', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(createId('d', 'u1'));
        tracker.onEvent(update('1', 'completed'));
        tracker.onEvent(result('u1', created('4', 'd')));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(rows)).toEqual([{ title: 'd', status: 'pending' }]);
        const { tracker: t2, rows: r2 } = setup();
        t2.onEvent(start());
        t2.onEvent(createId('d', 'u1'));
        t2.onEvent(result('u1', created('4', 'd')));
        t2.onEvent(update('4', 'completed'));
        t2.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(r2)).toEqual([{ title: 'd', status: 'completed' }]);
      });

      test('an unknown-id update with status deleted is ignored even with a subject', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(update('3', 'deleted', { subject: 'gone' }));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(rows).toHaveLength(0);
      });

      test('TaskUpdate for an unknown id adds the step when it carries a subject, else is ignored', () => {
        const { tracker, rows } = setup();
        tracker.onEvent(start());
        tracker.onEvent(update('3', 'completed'));
        expect(rows).toHaveLength(0);
        tracker.onEvent(update('3', 'in_progress', { subject: 'old step' }));
        tracker.onEvent({ type: 'turn_end', outcome: 'done' });
        expect(last(rows)).toEqual([{ title: 'old step', status: 'in_progress' }]);
      });
    });

    test('a Bash call then TaskUpdate keeps the Bash description', () => {
      const { tracker, rows, advance } = setup();
      tracker.onEvent(start());
      tracker.onEvent({ type: 'tool', name: 'Bash', input: { description: 'List files' } });
      tracker.onEvent(update('9', 'completed'));
      tracker.onEvent({ type: 'tool', name: 'TaskList', input: {} });
      advance(5000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.doing).toBe('List files');
    });

    test('ToolSearch alone does not open the plan', () => {
      const { tracker, rows, advance } = setup();
      tracker.onEvent(start());
      tracker.onEvent(tool('ToolSearch'));
      advance(6000);
      expect(rows).toHaveLength(0);
    });

    test('TodoWrite still works', () => {
      const { tracker, rows } = setup();
      tracker.onEvent(start());
      tracker.onEvent(todos('completed', 'in_progress'));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.todos).toEqual([
        { title: 'step 0', status: 'completed' },
        { title: 'step 1', status: 'in_progress' },
      ]);
    });
  });

  test('stepsOpen is true only while this turn answers that chat and has unfinished steps', () => {
    const { tracker } = setup();
    expect(tracker.stepsOpen('C1')).toBe(false);
    tracker.onEvent(start());
    expect(tracker.stepsOpen('C1')).toBe(false);
    tracker.onEvent(todos('completed', 'in_progress'));
    expect(tracker.stepsOpen('C1')).toBe(true);
    expect(tracker.stepsOpen('C2')).toBe(false);
    tracker.onEvent(todos('completed', 'completed'));
    expect(tracker.stepsOpen('C1')).toBe(false);
    tracker.onEvent(todos('pending'));
    tracker.onEvent({ type: 'turn_end', outcome: 'done' });
    expect(tracker.stepsOpen('C1')).toBe(false);
  });

  test('stepsOpen is false when the host showed no plan for the turn (a2a room, group off)', () => {
    const { tracker } = setup();
    tracker.onEvent(start({}, []));
    tracker.onEvent(todos('pending', 'in_progress'));
    expect(tracker.stepsOpen('C1')).toBe(false);
  });

  test('a follow-up adopted into the turn that carries the display row turns holding on', () => {
    const { tracker } = setup();
    tracker.onEvent(start({}, []));
    tracker.onEvent(todos('in_progress'));
    expect(tracker.stepsOpen('C1')).toBe(false);
    tracker.onEvent(start({}, [DISPLAY_ROW]));
    expect(tracker.stepsOpen('C1')).toBe(true);
  });

  test('stepsOpen is false when the feature is off', () => {
    const { tracker } = setup({ enabled: false });
    tracker.onEvent(start());
    tracker.onEvent(todos('pending'));
    expect(tracker.stepsOpen('C1')).toBe(false);
  });
});
