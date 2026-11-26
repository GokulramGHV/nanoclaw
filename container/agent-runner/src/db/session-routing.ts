/**
 * Reply routing: the chat this session is bound to (`getSessionRouting`, written
 * by the host on every wake — see src/session-manager.ts `writeSessionRouting`)
 * and the thread a send to a channel should land in (`resolveDestinationThread`).
 */
import { getAgentMailbox } from '../mailbox/index.js';
import type { ReplyRoute } from './session-state.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const routing = getAgentMailbox().operations.getSessionRouting();
  return {
    channel_type: routing.channelType,
    platform_id: routing.platformId,
    thread_id: routing.threadId,
  };
}

/**
 * The thread a send to `channelType`+`platformId` should land in, plus the
 * inbound id for the a2a return path.
 *
 * When the message being answered (`replyingTo`) came from that channel, its
 * thread is the answer — a reply lands where the request was made even if a
 * newer message from another thread arrived mid-turn. Otherwise fall back to
 * the latest inbound row from that channel (an agent-shared session sending to
 * a channel other than the one it is answering), and to no thread at all when
 * nothing has arrived from it.
 *
 * Never `session_routing.thread_id`: the bound thread is null for every session
 * that isn't per-thread (shared, agent-shared, DM sub-threads) even when the
 * request arrived in a thread. Shared by the poll loop's explicit deliveries and
 * the send tools so `<message to>`, `send_message` and `send_file` all thread
 * identically. Never throws.
 */
export function resolveDestinationThread(
  channelType: string,
  platformId: string,
  replyingTo?: (Omit<ReplyRoute, 'inReplyTo'> & { inReplyTo: string | null }) | null,
): { threadId: string | null; inReplyTo: string | null } | null {
  if (replyingTo && replyingTo.channelType === channelType && replyingTo.platformId === platformId) {
    return { threadId: replyingTo.threadId, inReplyTo: replyingTo.inReplyTo };
  }
  try {
    return (
      getAgentMailbox().operations.getLatestInboundRoute(channelType, platformId) ??
      taskOriginDestinationThread(channelType, platformId)
    );
  } catch (err) {
    console.error(
      `[session-routing] resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

/**
 * Task rows carry no route of their own (they fire in an isolated session), so
 * a task created from a chat thread records that route in its content. A send
 * from a run of that task to the same channel lands in the recorded thread.
 * Mirrors `parseTaskContent` on the host (no shared modules across the mount).
 */
function taskOriginDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: null } | null {
  const seriesId = getTaskSeriesId();
  if (!seriesId) return null;
  const raw = getAgentMailbox().operations.getTaskContent(seriesId);
  if (!raw) return null;
  let route: Record<string, unknown> | null = null;
  try {
    const origin = (JSON.parse(raw) as Record<string, unknown>).originRoute;
    route = typeof origin === 'object' && origin !== null ? (origin as Record<string, unknown>) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return null;
  }
  if (!route || route.channelType !== channelType || route.platformId !== platformId) return null;
  if (route.threadId !== null && route.threadId !== undefined && typeof route.threadId !== 'string') return null;
  return { threadId: route.threadId ?? null, inReplyTo: null };
}

const TASK_THREAD_PREFIX = 'system:tasks:';

/** The task id encoded in this isolated task session's canonical thread id. */
export function getTaskSeriesId(): string | null {
  const threadId = getSessionRouting().thread_id;
  return threadId?.startsWith(TASK_THREAD_PREFIX) ? threadId.slice(TASK_THREAD_PREFIX.length) : null;
}
