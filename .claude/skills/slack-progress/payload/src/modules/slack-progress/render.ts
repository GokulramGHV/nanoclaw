/**
 * Pure rendering of the progress plan message. One Slack `plan` block with a
 * `task_card` per todo while working, and a closing summary once the turn ends.
 */

export interface ProgressTodo {
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Host-side mirror of the container's progress row. */
export interface ProgressRow {
  action: 'progress';
  turnId: string;
  platformId: string;
  threadId: string | null;
  todos: ProgressTodo[];
  doing: string | null;
  startedAt: string;
  elapsedMs: number;
  outcome: 'working' | 'done' | 'error';
}

type CardStatus = 'pending' | 'in_progress' | 'complete' | 'error';
interface Card {
  type: 'task_card';
  task_id: string;
  title: string;
  status: CardStatus;
  details?: unknown;
}

const TITLE_MAX = 150;
const TEXT_MAX = 3000;
const MAX_CARDS = 30;

/** Entity-escape text that Slack parses as mrkdwn. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function details(text: string): unknown {
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: clip(text, TEXT_MAX) }] }],
  };
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function cards(row: ProgressRow, finalOutcome: ProgressRow['outcome']): Card[] {
  if (row.todos.length === 0) {
    const title = clip(row.doing ?? 'Working', TITLE_MAX) || 'Working';
    const status: CardStatus =
      finalOutcome === 'done' ? 'complete' : finalOutcome === 'error' ? 'error' : 'in_progress';
    return [{ type: 'task_card', task_id: 't0', title, status }];
  }
  return row.todos.slice(0, MAX_CARDS).map((t, i): Card => {
    const title = clip(t.title, TITLE_MAX) || `Step ${i + 1}`;
    let status: CardStatus;
    if (t.status === 'completed') status = 'complete';
    else if (t.status === 'in_progress')
      status = finalOutcome === 'done' ? 'complete' : finalOutcome === 'error' ? 'error' : 'in_progress';
    else status = 'pending';
    const card: Card = { type: 'task_card', task_id: `t${i}`, title, status };
    if (status === 'in_progress' && row.doing) card.details = details(row.doing);
    return card;
  });
}

export function renderPlan(row: ProgressRow, opts: { pendingOk: boolean }): { text: string; blocks: unknown[] } {
  let list = cards(row, 'working');
  const blocks: unknown[] = [];
  const held = opts.pendingOk ? [] : list.filter((c) => c.status === 'pending');
  if (!opts.pendingOk) list = list.filter((c) => c.status !== 'pending');
  const text = escapeMrkdwn(
    clip(`Working: ${row.doing ?? list.find((c) => c.status === 'in_progress')?.title ?? '...'}`, 300),
  );
  if (list.length > 0) blocks.push({ type: 'plan', title: 'Working', tasks: list });
  if (held.length > 0) {
    const lines = held.map((c) => `• ${escapeMrkdwn(c.title)}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Next:\n${lines}`.slice(0, TEXT_MAX) } });
  }
  return { text, blocks };
}

export function renderSummary(row: ProgressRow): { text: string; blocks: unknown[] } {
  const failed = row.outcome === 'error';
  const steps = row.todos.length;
  const head = failed
    ? `Stopped after ${seconds(row.elapsedMs)}`
    : `Done in ${seconds(row.elapsedMs)}${steps > 0 ? `, ${steps} ${steps === 1 ? 'step' : 'steps'}` : ''}`;
  const list = cards(row, row.outcome).filter((c) => c.status !== 'pending');
  // Keep the top-level text well inside Slack's 3000-character limit.
  const lines = row.todos.map((t) => escapeMrkdwn(clip(t.title, TITLE_MAX)));
  let text = head;
  for (const l of lines) {
    if (text.length + l.length + 3 > TEXT_MAX - 1) break;
    text += `\n• ${l}`;
  }
  const blocks: unknown[] = list.length > 0 ? [{ type: 'plan', title: head, tasks: list }] : [];
  return { text: text.slice(0, TEXT_MAX), blocks };
}
