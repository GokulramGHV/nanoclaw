/**
 * Pure rendering of the progress message. While working it is one standalone
 * `task_card` per step (these render open). When the turn ends it is redrawn as one
 * `plan` block summary (this collapses, which is fine at the end).
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
const MAX_WORKING_CARDS = 20;

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

function cards(row: ProgressRow, finalOutcome: ProgressRow['outcome'], limit = MAX_CARDS): Card[] {
  if (row.todos.length === 0) {
    // A finished turn with no todos has no steps to show, so no placeholder card.
    if (finalOutcome === 'done') return [];
    const title = clip(row.doing ?? 'Working', TITLE_MAX) || 'Working';
    const status: CardStatus = finalOutcome === 'error' ? 'error' : 'in_progress';
    return [{ type: 'task_card', task_id: 't0', title, status }];
  }
  return row.todos.slice(0, limit).map((t, i): Card => {
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

/** Section text of whole bullet lines that fits TEXT_MAX, so an escape entity is never cut in half. */
function bulletSection(head: string, titles: string[]): unknown {
  let body = head;
  let shown = 0;
  for (const t of titles) {
    const line = `\n• ${escapeMrkdwn(clip(t, TITLE_MAX) || 'Step')}`;
    const more = `\n• and ${titles.length - shown} more`;
    // Leave room for the "and N more" line unless this is the last one that fits.
    const reserve = shown + 1 < titles.length ? more.length : 0;
    if (body.length + line.length + reserve > TEXT_MAX) break;
    body += line;
    shown++;
  }
  if (shown < titles.length) body += `\n• and ${titles.length - shown} more`;
  return { type: 'section', text: { type: 'mrkdwn', text: body } };
}

/**
 * The working view: one standalone task card per step (standalone cards render open,
 * a `plan` block does not). With `pendingOk` false (Slack refused a pending card),
 * steps not started yet are listed in one small grey line instead.
 */
export function renderPlan(
  row: ProgressRow,
  opts: { pendingOk: boolean } = { pendingOk: true },
): { text: string; blocks: unknown[] } {
  const all = cards(row, 'working', Infinity);
  const listed = opts.pendingOk ? all : all.filter((c) => c.status !== 'pending');
  const waiting = opts.pendingOk ? [] : all.filter((c) => c.status === 'pending').map((c) => c.title);
  const shown = listed.slice(0, MAX_WORKING_CARDS);
  const active = row.todos.find((t) => t.status === 'in_progress')?.title;
  const text = escapeMrkdwn(clip(`Working: ${active ?? row.doing ?? '...'}`, 300));
  const blocks: unknown[] = [...shown];
  if (listed.length > shown.length) {
    const n = listed.length - shown.length;
    blocks.push(context(`and ${n} more ${n === 1 ? 'step' : 'steps'}`));
  }
  if (waiting.length > 0) blocks.push(context(upNext(waiting)));
  return { text, blocks };
}

function context(mrkdwn: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: mrkdwn }] };
}

/** "Up next: a · b · c", whole titles only, inside the text limit. */
function upNext(titles: string[]): string {
  let out = 'Up next:';
  let shown = 0;
  for (const t of titles) {
    const part = `${shown === 0 ? ' ' : ' · '}${escapeMrkdwn(clip(t, TITLE_MAX) || 'Step')}`;
    if (out.length + part.length + 20 > TEXT_MAX) break;
    out += part;
    shown++;
  }
  if (shown < titles.length) out += ` and ${titles.length - shown} more`;
  return out;
}

/** Plain-text close for when Slack refuses the plan block, so a message is never left in the working state. */
export function renderPlainSummary(row: ProgressRow): { text: string; blocks: unknown[] } {
  const { text } = renderSummary(row, { pendingOk: false });
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(text).slice(0, TEXT_MAX) } }] };
}

export function renderSummary(
  row: ProgressRow,
  opts: { pendingOk: boolean } = { pendingOk: true },
): { text: string; blocks: unknown[] } {
  const failed = row.outcome === 'error';
  const steps = row.todos.length;
  const head = failed
    ? `Stopped after ${seconds(row.elapsedMs)}`
    : `Done in ${seconds(row.elapsedMs)}${steps > 0 ? `, ${steps} ${steps === 1 ? 'step' : 'steps'}` : ''}`;
  let list = cards(row, row.outcome);
  const held = opts.pendingOk ? [] : list.filter((c) => c.status === 'pending');
  if (!opts.pendingOk) list = list.filter((c) => c.status !== 'pending');
  // Keep the top-level text well inside Slack's 3000-character limit.
  const lines = row.todos.map((t) => escapeMrkdwn(clip(t.title, TITLE_MAX)));
  let text = head;
  for (const l of lines) {
    if (text.length + l.length + 3 > TEXT_MAX - 1) break;
    text += `\n• ${l}`;
  }
  const blocks: unknown[] = list.length > 0 ? [{ type: 'plan', title: head, tasks: list }] : [];
  if (held.length > 0) {
    blocks.push(
      bulletSection(
        'Not done:',
        held.map((c) => c.title),
      ),
    );
  }
  return { text: text.slice(0, TEXT_MAX), blocks };
}
