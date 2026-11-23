/**
 * Streamed text replies. `stream_append` rows open and feed a Slack stream
 * (chat.startStream, chat.appendStream). When the finished reply's chat row
 * arrives, the delivery interceptor sends any text not yet shown, stops the
 * stream, and hands back the stream's message ts. Any failure makes the
 * interceptor decline, so the bridge posts the full reply as usual.
 * Nothing here throws to delivery.
 */
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { registerChatDeliveryInterceptor, registerDeliveryAction } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/types.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import type { Session } from '../../types.js';
import { getStream, upsertStream, type StreamRow } from './db/progress.js';
import { a2aRooms } from './a2a-rooms.js';
import { withRateLimitRetry } from './rate-limit.js';
import { isEnabled } from './settings.js';
import { clearStatusAfterStream, clearWakeStatus } from './status.js';

const NOTE_BELOW = '_Reply posted below._';

/** One Slack call, retried when Slack answers ratelimited. */
function call(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withRateLimitRetry(() => slackCall(token, method, body, 'stream'));
}

/**
 * Clear the assistant "Typing..." status after a stream ends. A normal post clears it in
 * Slack, a stream does not. Goes through the status module so it never overtakes the
 * turn's own status refresh, and is skipped while a turn owns the status.
 */
function clearTypingStatus(row: StreamRow, token: string): void {
  if (!row.threadTs) return;
  clearStatusAfterStream(row.sessionId, { token, channel: row.channelId, threadTs: row.threadTs });
}

const chains = new Map<string, Promise<unknown>>();
const teamCache = new Map<string, string>();

/** Test hook: forget all in-memory state. */
export function resetStreamState(): void {
  chains.clear();
  teamCache.clear();
}

/** Run work for one stream after earlier work for it, so Slack calls stay in order. */
function enqueue<T>(streamId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  const prev = chains.get(streamId) ?? Promise.resolve();
  const run = prev.then(fn).catch((err) => {
    log.warn('slack-progress: stream work failed', { streamId, err: String(err) });
    return fallback;
  });
  chains.set(streamId, run);
  void run.then(() => {
    if (chains.get(streamId) === run) chains.delete(streamId);
  });
  return run;
}

/**
 * True when the text has a bare @name the Slack adapter would turn into a mention.
 * This copies the adapter's rule: skip code and <...> tokens, and skip raw user ids.
 * Streamed pieces go out unchanged, so such a reply is posted normally instead.
 */
export function hasBareMention(text: string): boolean {
  const masked = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]*>/g, ' ');
  for (const m of masked.matchAll(/(?<![\w<])@(\w[\w-]*)/g)) {
    if (!/^[UW][A-Z0-9]+$/.test(m[1])) return true;
  }
  return false;
}

function stripSlack(id: string): string {
  return id.startsWith('slack:') ? id.slice('slack:'.length) : id;
}

/** `slack:<channel>:<ts>` -> ts, only when the channel matches. */
function threadTsFor(threadId: unknown, channel: string): string | null {
  if (typeof threadId !== 'string') return null;
  const parts = threadId.split(':');
  if (parts.length !== 3 || parts[0] !== 'slack' || parts[1] !== channel || parts[2] === '') return null;
  return parts[2];
}

async function teamIdFor(token: string): Promise<string> {
  const cached = teamCache.get(token);
  if (cached) return cached;
  const res = await slackCall(token, 'auth.test', {}, 'stream');
  if (typeof res.team_id !== 'string' || res.team_id === '') throw new Error('auth.test returned no team_id');
  teamCache.set(token, res.team_id);
  return res.team_id;
}

/** The session's own Slack chat: its channel id and instance, or null. */
async function ownSlackChat(session: Session): Promise<{ channel: string; instance: string } | null> {
  if (!session.messaging_group_id) return null;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg || mg.channel_type !== 'slack') return null;
  return { channel: stripSlack(mg.platform_id).split(':')[0], instance: mg.instance ?? mg.channel_type };
}

async function save(row: StreamRow, patch: Partial<StreamRow>): Promise<StreamRow> {
  const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
  await upsertStream(next);
  return next;
}

async function appendWork(content: Record<string, unknown>, session: Session): Promise<void> {
  const streamId = content.streamId;
  const text = content.text;
  if (typeof streamId !== 'string' || streamId === '' || typeof text !== 'string' || text === '') {
    log.warn('slack-progress: dropped malformed stream_append row');
    return;
  }
  if (!(await isEnabled(session.agent_group_id))) return;
  const chat = await ownSlackChat(session);
  if (!chat) return;
  const platformChannel = typeof content.platformId === 'string' ? stripSlack(content.platformId).split(':')[0] : '';
  if (platformChannel !== chat.channel) return;

  let row = await getStream(streamId);
  if (row && (row.sessionId !== session.id || row.status !== 'open')) return;
  const now = new Date().toISOString();
  if (!row) {
    const threadTs = threadTsFor(content.threadId, chat.channel);
    row = {
      streamId,
      sessionId: session.id,
      instance: chat.instance,
      channelId: chat.channel,
      threadTs,
      streamTs: null,
      status: 'open',
      sentText: '',
      updatedAt: now,
      createdAt: now,
    };
    const token = envValue(botTokenKeyForInstance(chat.instance));
    const recipient = typeof content.recipient === 'string' ? stripSlack(content.recipient) : '';
    if (!token || !threadTs || !recipient || a2aRooms().has(chat.channel)) {
      await upsertStream({ ...row, status: 'failed' });
      return;
    }
    await upsertStream(row);
    try {
      const team = await teamIdFor(token);
      const res = await call(token, 'chat.startStream', {
        channel: chat.channel,
        thread_ts: threadTs,
        recipient_user_id: recipient,
        recipient_team_id: team,
        markdown_text: text,
      });
      if (typeof res.ts !== 'string') throw new Error('Slack did not return a stream timestamp');
      await save(row, { streamTs: res.ts, sentText: text });
    } catch (err) {
      log.warn('slack-progress: could not start stream', { streamId, err: String(err) });
      await save(row, { status: 'failed' });
    }
    return;
  }

  const token = envValue(botTokenKeyForInstance(row.instance));
  if (!token || !row.streamTs) {
    await save(row, { status: 'failed' });
    return;
  }
  try {
    await call(token, 'chat.appendStream', { channel: row.channelId, ts: row.streamTs, markdown_text: text });
    await save(row, { sentText: row.sentText + text });
  } catch (err) {
    log.warn('slack-progress: stream append failed', { streamId, err: String(err) });
    await save(row, { status: 'failed' });
  }
}

export async function handleStreamAppend(content: Record<string, unknown>, session: Session): Promise<void> {
  const id = content.streamId;
  if (typeof id !== 'string' || id === '') {
    log.warn('slack-progress: dropped malformed stream_append row');
    return;
  }
  // A reply is starting to stream: the wake status must not keep coming back over it.
  clearWakeStatus(session.id);
  await enqueue(id, () => appendWork(content, session), undefined);
}

/** End a stream with a short note, ignoring Slack errors. Used when a reply is posted instead. */
export async function endWithNote(row: StreamRow, note: string): Promise<void> {
  const token = envValue(botTokenKeyForInstance(row.instance));
  if (!token || !row.streamTs) return;
  try {
    await call(token, 'chat.stopStream', { channel: row.channelId, ts: row.streamTs, markdown_text: note });
    clearTypingStatus(row, token);
  } catch (err) {
    log.warn('slack-progress: could not end stream with note', { streamId: row.streamId, err: String(err) });
  }
}

async function abortWork(content: Record<string, unknown>, session: Session): Promise<void> {
  const id = content.streamId as string;
  if (!(await isEnabled(session.agent_group_id))) return;
  const row = await getStream(id);
  if (!row || row.sessionId !== session.id || row.status !== 'open') return;
  const token = envValue(botTokenKeyForInstance(row.instance));
  if (!row.streamTs || !token) {
    await save(row, { status: 'failed' });
    return;
  }
  try {
    await call(token, 'chat.stopStream', { channel: row.channelId, ts: row.streamTs });
    clearTypingStatus(row, token);
    await save(row, { status: 'stopped' });
    await call(token, 'chat.delete', { channel: row.channelId, ts: row.streamTs });
  } catch (err) {
    log.warn('slack-progress: stream abort failed', { streamId: id, err: String(err) });
    await save(row, { status: 'failed' });
  }
}

export async function handleStreamAbort(content: Record<string, unknown>, session: Session): Promise<void> {
  const id = content.streamId;
  if (typeof id !== 'string' || id === '') return;
  await enqueue(id, () => abortWork(content, session), undefined);
}

async function interceptWork(
  streamId: string,
  finalText: string,
  session: Session,
  chat: { channel: string },
): Promise<string | null> {
  const row = await getStream(streamId);
  if (!row || row.sessionId !== session.id || row.channelId !== chat.channel) return null;
  if (row.status === 'failed') {
    await endWithNote(row, NOTE_BELOW);
    return null;
  }
  if (row.status !== 'open') return null;
  const token = envValue(botTokenKeyForInstance(row.instance));
  if (!token || !row.streamTs) {
    await save(row, { status: 'failed' });
    return null;
  }
  if (hasBareMention(finalText)) {
    await save(row, { status: 'failed' });
    await endWithNote(row, NOTE_BELOW);
    return null;
  }
  // The streamed text keeps the newlines after <message> and before </message>, but the
  // final chat text is trimmed. Ignore leading and trailing whitespace of the streamed part.
  const shown = row.sentText.trim();
  if (!finalText.startsWith(shown)) {
    await save(row, { status: 'failed' });
    await endWithNote(row, NOTE_BELOW);
    return null;
  }
  const tail = finalText.slice(shown.length);
  const rest = tail.trim() === '' ? '' : tail;
  try {
    if (rest !== '') {
      await call(token, 'chat.appendStream', { channel: row.channelId, ts: row.streamTs, markdown_text: rest });
    }
    await call(token, 'chat.stopStream', { channel: row.channelId, ts: row.streamTs });
    clearTypingStatus(row, token);
  } catch (err) {
    log.warn('slack-progress: could not finish stream', { streamId, err: String(err) });
    await save(row, { status: 'failed' });
    await endWithNote(row, NOTE_BELOW);
    return null;
  }
  await save(row, { status: 'stopped', sentText: finalText }).catch((err) => {
    log.warn('slack-progress: could not record stopped stream', { streamId, err: String(err) });
  });
  return row.streamTs;
}

/** Deliver a finished reply through its stream. Null declines, so the bridge posts it. */
export async function interceptStreamedReply(
  msg: OutboundMessage,
  session: Session,
  content: Record<string, unknown>,
): Promise<string | null> {
  const streamId = content.stream;
  if (typeof streamId !== 'string' || streamId === '') return null;
  if (Array.isArray(content.files) && content.files.length > 0) return null;
  if ('operation' in content) return null;
  const text =
    typeof content.text === 'string' ? content.text : typeof content.markdown === 'string' ? content.markdown : null;
  if (text === null) return null;
  try {
    if (msg.channelType !== 'slack' || !msg.platformId) return null;
    if (!(await isEnabled(session.agent_group_id))) return null;
    const chat = await ownSlackChat(session);
    if (!chat || stripSlack(msg.platformId).split(':')[0] !== chat.channel) return null;
    return await enqueue<string | null>(streamId, () => interceptWork(streamId, text, session, chat), null);
  } catch (err) {
    log.warn('slack-progress: stream interceptor failed', { streamId, err: String(err) });
    return null;
  }
}

registerDeliveryAction('stream_append', handleStreamAppend, unguarded("posts only into the session's own chat"));
registerDeliveryAction('stream_abort', handleStreamAbort, unguarded("removes only the session's own stream message"));
registerChatDeliveryInterceptor(interceptStreamedReply);
