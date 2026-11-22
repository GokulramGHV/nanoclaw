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
  lines: string[];
  playful: string[];
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

/**
 * Light-hearted lines Slack rotates through while the agent works, so the status
 * never reads as a flat "is working". Slack puts the app name in front of each.
 */
export const PLAYFUL_LINES = [
  'is noodling on it...',
  'is pondering...',
  'is mulling it over...',
  'is cooking something up...',
  'is crunching...',
  'is tinkering...',
  'is untangling things...',
  'is connecting the dots...',
  'is brewing...',
  'is sharpening pencils...',
  'is rummaging around...',
  'is piecing it together...',
  'is chasing a hunch...',
  'is herding bits...',
  'is shuffling papers...',
  'is in the zone...',
  'is turning it over...',
  'is wrangling details...',
  'is consulting the notes...',
  'is lining things up...',
];

/** Pick `n` different playful lines. `rand` is injectable for tests. */
export function pickPlayful(n: number, rand: () => number = Math.random): string[] {
  const pool = [...PLAYFUL_LINES];
  const out: string[] = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  return out;
}

/** The lines to rotate: the real step first when known, then a few playful ones. Slack allows 10. */
export function loadingLines(status: string, hasLabel: boolean, playful: string[]): string[] {
  return hasLabel ? [status, ...playful.slice(0, 3)] : playful.slice(0, 5);
}

export function statusText(doing: string | null): string {
  const clean = (doing ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'is working';
  const cut = clean.length > MAX_DOING_CHARS ? `${clean.slice(0, MAX_DOING_CHARS - 3)}...` : clean;
  return `is working: ${cut}`;
}

function send(sessionId: string, target: StatusTarget, status: string, lines: string[] = []): void {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const run = prev
    .then(() =>
      slackCall(
        target.token,
        'assistant.threads.setStatus',
        // Slack rotates the loading messages over the status text, so always send our own
        // (otherwise it keeps showing the generic "Typing..." list). Clearing sends none.
        status
          ? {
              channel_id: target.channel,
              thread_ts: target.threadTs,
              status,
              loading_messages: lines.length > 0 ? lines : [status],
            }
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
  send(sessionId, a, a.text, a.lines);
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
    const hasLabel = text !== statusText(null);
    // Keep the same playful picks for a turn so the rotation does not reshuffle on every step.
    const playful = cur && cur.turnId === turnId ? cur.playful : pickPlayful(5);
    const a: Active = {
      ...target,
      turnId,
      text,
      playful,
      lines: loadingLines(text, hasLabel, playful),
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
