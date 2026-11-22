/**
 * Stream builder. While the agent writes a <message> block for the chat that
 * woke it, this turns the visible text into batched `stream_append` rows.
 *
 * Streaming only happens when the destination is the turn's own Slack chat,
 * the reply has a thread, and one human woke the turn. A finished block is
 * queued per chat so `decorate` can tag that block's normal chat row with the
 * stream id. A block that never streamed gets a null entry, which keeps the
 * queue in step with the chat rows.
 */
import type { MessageInRow } from '../../db/messages-in.js';
import type { ChatRowInfo, ProgressEvent } from '../../progress-seam.js';
import { createSplitter } from './splitter.js';

export const MARKER_PATH = '/workspace/agent/.slack-progress-enabled';

export interface StreamAppendRow {
  action: 'stream_append';
  streamId: string;
  platformId: string;
  threadId: string;
  recipient: string;
  text: string;
}

export interface StreamerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  send(row: StreamAppendRow): void;
  enabled(): boolean;
  newId(): string;
  resolve(to: string): { platformId: string; channelType: string } | null;
}

const BATCH_MS = 500;

interface Block {
  id: string;
  pending: string;
  sentRows: number;
  cancelTimer: (() => void) | null;
}

interface Turn {
  platformId: string;
  threadId: string;
  recipient: string;
  splitter: ReturnType<typeof createSplitter>;
  block: Block | null;
  /** The open block is not for the turn's own chat, so nothing is streamed. */
  skipping: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Same rule as the formatter's sender id: namespaced with the channel type. */
function senderOf(
  msg: MessageInRow,
  content: { senderId?: string; author?: { userId?: string } } | null,
): string | null {
  const raw = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  if (raw.includes(':')) return raw;
  return msg.channel_type ? `${msg.channel_type}:${raw}` : raw;
}

/** The one human sender of the waking rows, or null when streaming is not allowed. */
function soleHumanSender(messages: MessageInRow[]): string | null {
  const senders = new Set<string>();
  let waking = 0;
  for (const m of messages) {
    if (m.trigger === 0) continue;
    waking++;
    if (m.kind === 'task' || m.on_wake === 1) return null;
    const content = parse(m.content);
    const id = senderOf(m, content);
    if (!id) return null;
    if (content?.author?.isBot === true || id.startsWith('slack:bot:')) return null;
    senders.add(id);
  }
  if (waking === 0 || senders.size !== 1) return null;
  return [...senders][0];
}

export function createStreamer(deps: StreamerDeps): {
  onEvent(e: ProgressEvent): void;
  decorate(row: ChatRowInfo): Record<string, unknown> | null;
} {
  let active = false;
  let turn: Turn | null = null;
  const finished = new Map<string, (string | null)[]>();

  function flush(t: Turn): void {
    const b = t.block;
    if (!b) return;
    b.cancelTimer?.();
    b.cancelTimer = null;
    if (b.pending === '') return;
    const text = b.pending;
    b.pending = '';
    b.sentRows++;
    deps.send({
      action: 'stream_append',
      streamId: b.id,
      platformId: t.platformId,
      threadId: t.threadId,
      recipient: t.recipient,
      text,
    });
  }

  function queueFinished(platformId: string, id: string | null): void {
    const q = finished.get(platformId) ?? [];
    q.push(id);
    finished.set(platformId, q);
  }

  function handleText(t: Turn, text: string): void {
    const b = t.block;
    if (!b || t.skipping) return;
    b.pending += text;
    if (!b.cancelTimer) {
      b.cancelTimer = deps.setTimer(() => {
        b.cancelTimer = null;
        flush(t);
      }, BATCH_MS);
    }
  }

  function onEvent(e: ProgressEvent): void {
    switch (e.type) {
      case 'turn_start': {
        if (active) return;
        active = true;
        turn = null;
        finished.clear();
        const r = e.routing;
        if (!deps.enabled()) return;
        if (r.taskRun || r.channelType !== 'slack' || !r.platformId || !r.threadId) return;
        const sender = soleHumanSender(e.messages);
        if (!sender || !sender.startsWith('slack:')) return;
        turn = {
          platformId: r.platformId,
          threadId: r.threadId,
          recipient: sender.slice('slack:'.length),
          splitter: createSplitter(),
          block: null,
          skipping: false,
        };
        return;
      }
      case 'text_delta': {
        const t = turn;
        if (!active || !t) return;
        for (const op of t.splitter.feed(e.text)) {
          if (op.type === 'open') {
            const dest = deps.resolve(op.to);
            if (dest && dest.channelType === 'slack' && dest.platformId === t.platformId) {
              t.skipping = false;
              t.block = { id: deps.newId(), pending: '', sentRows: 0, cancelTimer: null };
            } else {
              t.skipping = true;
              t.block = null;
            }
          } else if (op.type === 'text') {
            handleText(t, op.text);
          } else {
            if (t.block) {
              flush(t);
              queueFinished(t.platformId, t.block.sentRows > 0 ? t.block.id : null);
            }
            t.block = null;
            t.skipping = false;
          }
        }
        return;
      }
      case 'turn_end': {
        if (!active) return;
        active = false;
        const t = turn;
        turn = null;
        if (t) flush(t);
        return;
      }
      default:
        return;
    }
  }

  function decorate(row: ChatRowInfo): Record<string, unknown> | null {
    const q = finished.get(row.platformId);
    if (!q || q.length === 0) return null;
    const id = q.shift() ?? null;
    return id ? { stream: id } : null;
  }

  return { onEvent, decorate };
}
