/**
 * Progress tracker. Turns progress events into throttled `progress` rows.
 *
 * - No row until the turn has run 5000 ms, or the first to-do list arrives.
 * - At most one row per 2000 ms, always carrying the latest state.
 * - The final row at turn end is never throttled.
 *
 * Only injected dependencies are used, so tests control time fully.
 */
import type { ProgressEvent } from '../../progress-seam.js';
import { describeTool } from './describe.js';

export interface ProgressRow {
  action: 'progress';
  turnId: string;
  platformId: string;
  threadId: string | null;
  todos: { title: string; status: 'pending' | 'in_progress' | 'completed' }[];
  doing: string | null;
  startedAt: string;
  elapsedMs: number;
  outcome: 'working' | 'done' | 'error';
}

export interface TrackerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  send(row: ProgressRow): void;
  enabled(): boolean;
  newId(): string;
}

const FIRST_ROW_MS = 5000;
const MIN_GAP_MS = 2000;

interface OpenTurn {
  turnId: string;
  platformId: string;
  threadId: string | null;
  startedAt: number;
  todos: ProgressRow['todos'];
  doing: string | null;
  sent: boolean;
  dirty: boolean;
  lastSendAt: number;
  cancelFirst: (() => void) | null;
  cancelFlush: (() => void) | null;
}

export function createProgressTracker(deps: TrackerDeps): { onEvent(e: ProgressEvent): void } {
  let turn: OpenTurn | null = null;

  function row(t: OpenTurn, outcome: ProgressRow['outcome']): ProgressRow {
    return {
      action: 'progress',
      turnId: t.turnId,
      platformId: t.platformId,
      threadId: t.threadId,
      todos: t.todos.map((x) => ({ ...x })),
      doing: t.doing,
      startedAt: new Date(t.startedAt).toISOString(),
      elapsedMs: deps.now() - t.startedAt,
      outcome,
    };
  }

  function emit(t: OpenTurn, outcome: ProgressRow['outcome']): void {
    t.sent = true;
    t.dirty = false;
    t.lastSendAt = deps.now();
    deps.send(row(t, outcome));
  }

  function flush(t: OpenTurn): void {
    if (turn !== t || !deps.enabled()) return;
    const eligible = deps.now() - t.startedAt >= FIRST_ROW_MS || t.todos.length > 0;
    if (!eligible) return;
    if (t.sent && !t.dirty) return;
    if (t.sent) {
      const wait = MIN_GAP_MS - (deps.now() - t.lastSendAt);
      if (wait > 0) {
        if (!t.cancelFlush) {
          t.cancelFlush = deps.setTimer(() => {
            t.cancelFlush = null;
            flush(t);
          }, wait);
        }
        return;
      }
    }
    t.cancelFlush?.();
    t.cancelFlush = null;
    emit(t, 'working');
  }

  function close(t: OpenTurn): void {
    t.cancelFirst?.();
    t.cancelFlush?.();
    turn = null;
  }

  function onEvent(e: ProgressEvent): void {
    switch (e.type) {
      case 'turn_start': {
        if (turn) return;
        const r = e.routing;
        if (r.taskRun || r.channelType !== 'slack' || !r.platformId) return;
        const t: OpenTurn = {
          turnId: deps.newId(),
          platformId: r.platformId,
          threadId: r.threadId,
          startedAt: deps.now(),
          todos: [],
          doing: null,
          sent: false,
          dirty: false,
          lastSendAt: 0,
          cancelFirst: null,
          cancelFlush: null,
        };
        turn = t;
        t.cancelFirst = deps.setTimer(() => {
          t.cancelFirst = null;
          flush(t);
        }, FIRST_ROW_MS);
        return;
      }
      case 'todos': {
        if (!turn) return;
        const next = (Array.isArray(e.todos) ? e.todos : []).map((x) => ({
          title: typeof x?.content === 'string' ? x.content : '',
          status: x?.status === 'in_progress' || x?.status === 'completed' ? x.status : ('pending' as const),
        }));
        if (JSON.stringify(next) !== JSON.stringify(turn.todos)) {
          turn.todos = next;
          turn.dirty = true;
        }
        flush(turn);
        return;
      }
      case 'tool': {
        if (!turn) return;
        const doing = describeTool(e.name, e.input);
        if (doing !== turn.doing) {
          turn.doing = doing;
          turn.dirty = true;
        }
        flush(turn);
        return;
      }
      case 'turn_end': {
        const t = turn;
        if (!t) return;
        const send = deps.enabled() && (t.sent || t.todos.length > 0);
        close(t);
        if (send) emit(t, e.outcome);
        return;
      }
      default:
        return;
    }
  }

  return { onEvent };
}
