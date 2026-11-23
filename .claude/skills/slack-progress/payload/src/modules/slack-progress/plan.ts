/**
 * `progress` delivery action: keep one plan message per turn in the session's
 * own Slack thread. The first row posts it, later rows edit it at most once per
 * 2000 ms (latest state wins), and a done or error row draws the summary at once
 * and closes the plan. The handler never throws to delivery.
 */
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/types.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { closePlan, getPlan, listOpenPlansForSession, upsertPlan, type PlanRow } from './db/progress.js';
import { a2aRooms } from './a2a-rooms.js';
import { withRateLimitRetry } from './rate-limit.js';
import { renderPlainSummary, renderPlan, renderSummary, type ProgressRow } from './render.js';
import { isEnabled } from './settings.js';
import { clearWorkingStatus, resetStatusState, setWorkingStatus } from './status.js';
import { stopPlan } from './stop.js';

export const EDIT_INTERVAL_MS = 2000;

interface Live {
  token: string;
  channel: string;
  latest: ProgressRow;
  lastDrawMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const live = new Map<string, Live>();
const chains = new Map<string, Promise<void>>();

/** Test hook: forget all in-memory state. */
export function resetPlanState(): void {
  for (const l of live.values()) if (l.timer) clearTimeout(l.timer);
  live.clear();
  chains.clear();
  resetStatusState();
}

/** `slack:<channel>:<ts>` -> ts, only when the channel matches. */
function threadTsFor(threadId: unknown, channel: string): string | null {
  if (typeof threadId !== 'string') return null;
  const parts = threadId.split(':');
  if (parts.length !== 3 || parts[0] !== 'slack' || parts[1] !== channel || parts[2] === '') return null;
  return parts[2];
}

function stripSlack(id: string): string {
  return id.startsWith('slack:') ? id.slice('slack:'.length) : id;
}

/** Check the shape defensively; bad rows come back null. */
export function parseProgressRow(content: Record<string, unknown>): ProgressRow | null {
  const { turnId, todos, outcome } = content;
  if (typeof turnId !== 'string' || turnId === '') return null;
  if (outcome !== 'working' && outcome !== 'done' && outcome !== 'error') return null;
  if (!Array.isArray(todos)) return null;
  const clean: ProgressRow['todos'] = [];
  for (const t of todos) {
    // One bad entry is skipped so it cannot freeze the whole plan.
    const o = t as { title?: unknown; status?: unknown };
    if (typeof o?.title !== 'string') continue;
    if (o.status !== 'pending' && o.status !== 'in_progress' && o.status !== 'completed') continue;
    clean.push({ title: o.title, status: o.status });
  }
  const elapsed = Number(content.elapsedMs);
  return {
    action: 'progress',
    turnId,
    platformId: typeof content.platformId === 'string' ? content.platformId : '',
    threadId: typeof content.threadId === 'string' ? content.threadId : null,
    todos: clean,
    doing: typeof content.doing === 'string' ? content.doing : null,
    startedAt: typeof content.startedAt === 'string' ? content.startedAt : new Date().toISOString(),
    elapsedMs: Number.isFinite(elapsed) ? elapsed : 0,
    outcome,
  };
}

/**
 * Send one post or update. `wanted` is checked right before each Slack call, so a draw
 * that slept through a rate-limit wait never lands after its plan was closed.
 */
async function send(
  method: 'chat.postMessage' | 'chat.update',
  token: string,
  base: Record<string, unknown>,
  row: ProgressRow,
  wanted: () => boolean = () => true,
): Promise<Record<string, unknown>> {
  const r = row.outcome === 'working' ? renderPlan(row) : renderSummary(row);
  const payload = { ...base, text: r.text, blocks: r.blocks };
  return await withRateLimitRetry(async () => (wanted() ? await slackCall(token, method, payload, 'progress') : {}));
}

async function persist(turnId: string, entry: Live, messageTs: string, row: ProgressRow, closed: boolean) {
  const plan = await getPlan(turnId);
  if (!plan || plan.closed) return;
  const next: PlanRow = {
    ...plan,
    messageTs,
    stateJson: JSON.stringify(row),
    lastDrawnAt: new Date(entry.lastDrawMs).toISOString(),
    updatedAt: new Date().toISOString(),
    closed,
  };
  await upsertPlan(next);
}

async function draw(turnId: string, ts: string): Promise<void> {
  const entry = live.get(turnId);
  if (!entry || entry.closed) return;
  entry.timer = null;
  const row = entry.latest;
  entry.lastDrawMs = Date.now();
  try {
    await send('chat.update', entry.token, { channel: entry.channel, ts }, row, () => !entry.closed);
    if (entry.closed) return;
    await persist(turnId, entry, ts, row, false);
  } catch (err) {
    log.warn('slack-progress: plan update failed', { turnId, err: String(err) });
  }
}

async function finish(turnId: string, sessionId: string, ts: string, row: ProgressRow): Promise<void> {
  const entry = live.get(turnId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.closed = true;
  entry.latest = row;
  clearWorkingStatus(sessionId, turnId);
  try {
    await send('chat.update', entry.token, { channel: entry.channel, ts }, row);
  } catch (err) {
    log.warn('slack-progress: summary update failed', { turnId, err: String(err) });
    // Slack refused the switch from task cards to a plan. Close with plain text instead.
    try {
      const plain = renderPlainSummary(row);
      await withRateLimitRetry(() =>
        slackCall(
          entry.token,
          'chat.update',
          { channel: entry.channel, ts, text: plain.text, blocks: plain.blocks },
          'progress',
        ),
      );
    } catch (err2) {
      log.warn('slack-progress: plain summary update failed', { turnId, err: String(err2) });
    }
  }
  await closePlan(turnId).catch((err) => {
    log.warn('slack-progress: could not close plan', { turnId, err: String(err) });
  });
  live.delete(turnId);
}

/**
 * A new turn in a session means any older open plan there will never finish (its
 * container was restarted, or the turn was cut short). Close those as stopped now
 * instead of waiting for the sweep. Never throws.
 */
async function stopOlderPlans(sessionId: string, turnId: string): Promise<void> {
  try {
    for (const old of await listOpenPlansForSession(sessionId)) {
      if (old.turnId === turnId) continue;
      const entry = live.get(old.turnId);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.closed = true;
        live.delete(old.turnId);
      }
      await stopPlan(old);
    }
  } catch (err) {
    log.warn('slack-progress: could not stop older plans', { sessionId, err: String(err) });
  }
}

async function process_(row: ProgressRow, content: Record<string, unknown>, session: Session): Promise<void> {
  if (!(await isEnabled(session.agent_group_id))) return;
  if (!session.messaging_group_id) return;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg || mg.channel_type !== 'slack') return;
  const channel = stripSlack(mg.platform_id);
  // Only the session's own chat gets a plan, and never an a2a room.
  if (stripSlack(row.platformId).split(':')[0] !== channel) return;
  if (a2aRooms().has(channel)) return;
  const instance = mg.instance ?? mg.channel_type;
  const token = envValue(botTokenKeyForInstance(instance));
  if (!token) return;
  const threadTs = threadTsFor(content.threadId, channel) ?? threadTsFor(session.thread_id, channel);

  const plan = await getPlan(row.turnId);
  if (plan?.closed) return;
  // The status line follows the plan's own gates. It needs a thread, and it never delays the plan.
  if (threadTs) {
    // Prefer the step in progress from the agent's own task list; fall back to the tool description.
    const label = row.todos.find((t) => t.status === 'in_progress')?.title ?? row.doing;
    if (row.outcome === 'working') setWorkingStatus(session.id, row.turnId, { token, channel, threadTs }, label);
    else clearWorkingStatus(session.id, row.turnId);
  }

  if (!plan) await stopOlderPlans(session.id, row.turnId);

  if (!plan || !plan.messageTs) {
    const now = new Date().toISOString();
    const base: PlanRow = plan ?? {
      turnId: row.turnId,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      instance,
      channelId: channel,
      threadTs,
      messageTs: null,
      stateJson: JSON.stringify(row),
      lastDrawnAt: null,
      updatedAt: now,
      closed: false,
      createdAt: now,
    };
    await upsertPlan(base);
    const res = await send('chat.postMessage', token, { channel, ...(threadTs ? { thread_ts: threadTs } : {}) }, row);
    if (typeof res.ts !== 'string') throw new Error('Slack did not return a message timestamp');
    const entry: Live = { token, channel, latest: row, lastDrawMs: Date.now(), timer: null, closed: false };
    live.set(row.turnId, entry);
    const finished = row.outcome !== 'working';
    await upsertPlan({
      ...base,
      messageTs: res.ts,
      stateJson: JSON.stringify(row),
      lastDrawnAt: new Date().toISOString(),
      closed: finished,
    });
    if (finished) live.delete(row.turnId);
    return;
  }

  const ts = plan.messageTs;
  let entry = live.get(row.turnId);
  if (!entry) {
    const last = plan.lastDrawnAt ? Date.parse(plan.lastDrawnAt) : 0;
    entry = {
      token,
      channel: plan.channelId,
      latest: row,
      lastDrawMs: Number.isFinite(last) ? last : 0,
      timer: null,
      closed: false,
    };
    live.set(row.turnId, entry);
  }
  entry.latest = row;
  if (row.outcome !== 'working') {
    await finish(row.turnId, session.id, ts, row);
    return;
  }
  if (entry.timer) return; // the pending draw will use the latest state
  const wait = entry.lastDrawMs + EDIT_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    await draw(row.turnId, ts);
  } else {
    entry.timer = setTimeout(() => void enqueue(row.turnId, () => draw(row.turnId, ts)), wait);
  }
}

/** Run work for one turn after earlier work for it, so a timer draw never races a post or the summary. */
async function enqueue(turnId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(turnId) ?? Promise.resolve();
  const run = prev.then(fn).catch((err) => {
    log.warn('slack-progress: queued plan work failed', { turnId, err: String(err) });
  });
  chains.set(turnId, run);
  await run;
  if (chains.get(turnId) === run) chains.delete(turnId);
}

export async function handleProgress(content: Record<string, unknown>, session: Session): Promise<void> {
  const row = parseProgressRow(content);
  if (!row) {
    log.warn('slack-progress: dropped malformed progress row');
    return;
  }
  await enqueue(row.turnId, async () => {
    try {
      await process_(row, content, session);
    } catch (err) {
      log.warn('slack-progress: progress action failed', { turnId: row.turnId, err: String(err) });
    }
  });
}

registerDeliveryAction('progress', handleProgress, unguarded("posts only into the session's own chat"));
