/**
 * Assistant status line: while a turn's plan is open, show what the agent is doing
 * under the thread ("is working: <doing>"). Slack clears the status on a normal reply
 * and after 2 minutes of silence, so a timer re-sends it while the turn is open. Each
 * send also pauses the generic typing refresher, which would otherwise overwrite it.
 * Everything here is best effort: errors are logged and never thrown.
 */
import { slackCall } from '../../channels/slack-lib.js';
import { log } from '../../log.js';
import { pauseTypingRefreshAfterDelivery } from '../typing/index.js';

export const STATUS_REFRESH_MS = 8000;
const MAX_DOING_CHARS = 100;

export interface StatusTarget {
  token: string;
  channel: string;
  threadTs: string;
}

interface Active extends StatusTarget {
  turnId: string;
  text: string;
  timer: ReturnType<typeof setInterval>;
}

const active = new Map<string, Active>();
/** One chain per session so a clear can never be overtaken by an earlier send. */
const chains = new Map<string, Promise<void>>();

/** Test hook: forget all in-memory state. */
export function resetStatusState(): void {
  for (const a of active.values()) clearInterval(a.timer);
  active.clear();
  chains.clear();
}

export function statusText(doing: string | null): string {
  const clean = (doing ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'is working';
  const cut = clean.length > MAX_DOING_CHARS ? `${clean.slice(0, MAX_DOING_CHARS - 3)}...` : clean;
  return `is working: ${cut}`;
}

function send(sessionId: string, target: StatusTarget, status: string): void {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const run = prev
    .then(() =>
      slackCall(
        target.token,
        'assistant.threads.setStatus',
        // Slack keeps rotating earlier loading messages over the status text,
        // so send the text as the only loading message too. Clearing sends none.
        status
          ? { channel_id: target.channel, thread_ts: target.threadTs, status, loading_messages: [status] }
          : { channel_id: target.channel, thread_ts: target.threadTs, status },
        'status',
      ),
    )
    .then(() => undefined)
    .catch((err) => {
      log.warn('slack-progress: could not set status', { sessionId, err: String(err) });
    });
  chains.set(sessionId, run);
  void run.then(() => {
    if (chains.get(sessionId) === run) chains.delete(sessionId);
  });
}

function refresh(sessionId: string, a: Active): void {
  safePause(sessionId);
  send(sessionId, a, a.text);
}

function safePause(sessionId: string): void {
  try {
    pauseTypingRefreshAfterDelivery(sessionId);
  } catch (err) {
    log.warn('slack-progress: could not pause typing refresh', { sessionId, err: String(err) });
  }
}

/** Show the status for an open turn. Calls Slack only when the text changed. Never throws. */
export function setWorkingStatus(sessionId: string, turnId: string, target: StatusTarget, doing: string | null): void {
  try {
    const text = statusText(doing);
    const cur = active.get(sessionId);
    if (cur && cur.turnId === turnId && cur.text === text) return;
    if (cur) clearInterval(cur.timer);
    const a: Active = {
      ...target,
      turnId,
      text,
      timer: setInterval(() => {
        const now = active.get(sessionId);
        if (now === a) refresh(sessionId, a);
      }, STATUS_REFRESH_MS),
    };
    a.timer.unref();
    active.set(sessionId, a);
    refresh(sessionId, a);
  } catch (err) {
    log.warn('slack-progress: status update failed', { sessionId, err: String(err) });
  }
}

/** Stop the refresh for a turn and clear the status. Does nothing if another turn owns it. Never throws. */
export function clearWorkingStatus(sessionId: string, turnId: string): void {
  try {
    const cur = active.get(sessionId);
    if (!cur || cur.turnId !== turnId) return;
    clearInterval(cur.timer);
    active.delete(sessionId);
    send(sessionId, cur, '');
  } catch (err) {
    log.warn('slack-progress: status clear failed', { sessionId, err: String(err) });
  }
}
