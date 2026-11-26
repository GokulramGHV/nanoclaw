/**
 * `post_card` delivery action: post an interactive card into the session's
 * own Slack chat. Order: find the v2 template and validate its data, check the
 * card id was not posted already, then hand the OpenUI Lang source to the kit,
 * which renders, posts and saves the card. The handler never throws to
 * delivery; every failure becomes a `post_card failed: ...` notice to the
 * agent (path-free, token-free).
 */
import path from 'node:path';

import Database from 'better-sqlite3';

import { CardRenderError, type CardRecord } from 'slack-ui-kit';

import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/types.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';
import { pauseTypingRefreshAfterDelivery } from '../typing/index.js';
import { sessionDir } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import { kit } from './kit.js';
import { notifyCardFailure } from './notify.js';
import { slackClientForToken } from './slack-client.js';
import { escapeEntities, findTemplate, TemplateError, validateData } from './template.js';

export const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class PostCardError extends Error {}

/** `slack:<channel>:<ts>` -> ts, only when the channel matches. */
export function threadTsFor(threadId: unknown, channel: string): string | null {
  if (typeof threadId !== 'string') return null;
  const parts = threadId.split(':');
  if (parts.length !== 3 || parts[0] !== 'slack' || parts[1] !== channel || parts[2] === '') return null;
  return parts[2];
}

export function stripSlack(id: string): string {
  return id.startsWith('slack:') ? id.slice('slack:'.length) : id;
}

type InboundRow = { kind: string; content: string; seq: number | null; trigger: number };

function parseContent(row: InboundRow): Record<string, unknown> | null {
  try {
    const content = JSON.parse(row.content) as unknown;
    return typeof content === 'object' && content !== null && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isCardEvent(row: InboundRow, content: Record<string, unknown> | null): boolean {
  return row.kind === 'webhook' && content?.source === 'slack-ui' && content.event === 'card_event';
}

function isAskAnswer(row: InboundRow, content: Record<string, unknown> | null): boolean {
  return row.kind === 'webhook' && content?.source === 'slack-ui' && content.event === 'ask_answer';
}

/** A row that can name an owner: a triggering chat message or slack-ui card_event. */
function isOwnerRow(row: InboundRow): boolean {
  if (row.trigger !== 1) return false;
  return (
    row.kind === 'chat' ||
    row.kind === 'chat-sdk' ||
    isCardEvent(row, parseContent(row)) ||
    isAskAnswer(row, parseContent(row))
  );
}

/** A chat row the host wrote as `system` (no person sent it). */
function isSystemNotice(row: InboundRow): boolean {
  return row.kind === 'chat' && parseContent(row)?.senderId === 'system';
}

/** The clicker for a slack-ui card_event row, else the chat sender. */
function senderOf(row: InboundRow): string | null {
  const content = parseContent(row);
  if (!content) return null;
  let id: unknown;
  if (isCardEvent(row, content) || isAskAnswer(row, content)) {
    const payload = content.payload as { user?: { id?: unknown } } | undefined;
    id = payload?.user?.id;
  } else {
    id = content.senderId;
  }
  if (typeof id !== 'string') return null;
  const clean = stripSlack(id);
  return clean === '' || clean === 'system' ? null : clean;
}

/**
 * Who the agent is answering, starting from the inbound message `messageId`
 * (the container's in-reply-to, the first row of its batch). That row may be
 * a context row (trigger=0) from a bystander, or not a chat message at all.
 * Then the owner is the sender of the earliest later row that is a
 * triggering chat message or slack-ui card_event. A host system notice names
 * no person. A `post_card failed` notice records the message the failed card
 * answered (`cardInReplyTo`), and the lookup follows it. For any other notice
 * the owner is the sender of the latest earlier owner row; in a busy thread
 * that can be someone who engaged the agent after the real requester. There
 * is no mailbox API to
 * read a message by id, so this opens the session's inbound.db read-only.
 * Never throws.
 */
export function readInboundSender(session: Session, messageId: unknown): string | null {
  if (typeof messageId !== 'string' || messageId === '') return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(sessionDir(session.agent_group_id, session.id), 'inbound.db'), {
      readonly: true,
      fileMustExist: true,
    });
    return senderFor(db, messageId, 0);
  } catch (err) {
    log.debug('slack-ui: could not read inbound sender', { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    db?.close();
  }
}

/** Follows at most this many `cardInReplyTo` links (a re-post that fails again adds one). */
const MAX_NOTICE_HOPS = 5;

function senderFor(db: Database.Database, messageId: string, hops: number): string | null {
  const row = db
    .prepare('SELECT kind, content, seq, "trigger" AS trigger FROM messages_in WHERE id = ?')
    .get(messageId) as InboundRow | undefined;
  if (!row) return null;
  const notice = isSystemNotice(row);
  if (!notice && isOwnerRow(row)) return senderOf(row);
  if (notice) {
    const answered = parseContent(row)?.cardInReplyTo;
    if (typeof answered === 'string' && answered !== messageId && hops < MAX_NOTICE_HOPS) {
      const followed = senderFor(db, answered, hops + 1);
      if (followed) return followed;
    }
  }
  if (row.seq === null) return null;
  if (notice) {
    const earlier = db
      .prepare(
        `SELECT kind, content, seq, "trigger" AS trigger FROM messages_in
         WHERE seq < ? AND "trigger" = 1 AND kind IN ('chat', 'chat-sdk', 'webhook')
         ORDER BY seq DESC`,
      )
      .iterate(row.seq) as IterableIterator<InboundRow>;
    for (const prev of earlier) {
      if (isOwnerRow(prev) && !isSystemNotice(prev)) return senderOf(prev);
    }
    return null;
  }
  const later = db
    .prepare(
      `SELECT kind, content, seq, "trigger" AS trigger FROM messages_in
       WHERE seq > ? AND "trigger" = 1 AND kind IN ('chat', 'chat-sdk', 'webhook')
       ORDER BY seq`,
    )
    .iterate(row.seq) as IterableIterator<InboundRow>;
  for (const next of later) {
    if (isOwnerRow(next)) return senderOf(next);
  }
  return null;
}

const TASK_THREAD_PREFIX = 'system:tasks:';

/**
 * The chat route a scheduled task was created from, read from the task row in
 * the host's own copy of the session's inbound.db (never from anything the
 * container sends). Null when the session is not a task session, the row is
 * gone, or the task recorded no route. Never throws.
 */
export function readTaskOriginRoute(
  session: Session,
): { channelType: string; platformId: string; threadId: string | null } | null {
  if (!session.thread_id?.startsWith(TASK_THREAD_PREFIX)) return null;
  const seriesId = session.thread_id.slice(TASK_THREAD_PREFIX.length);
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(sessionDir(session.agent_group_id, session.id), 'inbound.db'), {
      readonly: true,
      fileMustExist: true,
    });
    const row = db
      .prepare("SELECT content FROM messages_in WHERE kind = 'task' AND (id = ? OR series_id = ?) ORDER BY seq DESC LIMIT 1")
      .get(seriesId, seriesId) as { content: string } | undefined;
    if (!row) return null;
    const route = (JSON.parse(row.content) as Record<string, unknown>).originRoute as Record<string, unknown> | undefined;
    if (typeof route !== 'object' || route === null) return null;
    if (typeof route.channelType !== 'string' || typeof route.platformId !== 'string') return null;
    if (route.threadId !== null && route.threadId !== undefined && typeof route.threadId !== 'string') return null;
    return { channelType: route.channelType, platformId: route.platformId, threadId: route.threadId ?? null };
  } catch (err) {
    log.debug('slack-ui: could not read task origin route', { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    db?.close();
  }
}

/**
 * The chat a session's cards and questions go into: its own messaging group, or, for a scheduled
 * task's run (no messaging group), the chat the task was created from, which must be wired to this
 * session's agent group. `originThreadId` is the recorded thread for that case. Throws a plain
 * `Error` with the agent-facing reason when there is no chat.
 */
export async function resolveSessionChat(
  session: Session,
): Promise<{ mg: MessagingGroup; originThreadId: string | null }> {
  const noChat = new Error('this session has no chat to post into');
  if (session.messaging_group_id) {
    const mg = await getMessagingGroup(session.messaging_group_id);
    if (!mg) throw noChat;
    return { mg, originThreadId: null };
  }
  const route = readTaskOriginRoute(session);
  if (!route) throw noChat;
  const wired = (await getMessagingGroupsByAgentGroup(session.agent_group_id)).filter(
    (g) => g.channel_type === route.channelType && g.platform_id === route.platformId,
  );
  const mg = wired.find((g) => (g.instance ?? g.channel_type) === g.channel_type) ?? wired[0];
  if (!mg) throw new Error("the task's chat is not wired to this agent");
  return { mg, originThreadId: route.threadId };
}

/** First line of an error, without file paths or anything token-shaped, capped for the notice. */
export function shortMessage(err: unknown): string {
  const first = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return first
    .replace(/xox[a-z]-[\w-]+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\\/-]*[\\/][\w.\\/-]+/g, '[path]')
    .slice(0, 200);
}

async function postCard(content: Record<string, unknown>, session: Session): Promise<void> {
  const { cardId, template: templateName } = content;
  if (typeof cardId !== 'string' || !CARD_ID_RE.test(cardId)) throw new PostCardError('invalid cardId');
  if (typeof templateName !== 'string' || templateName === '') throw new PostCardError('template is required');

  const { mg, originThreadId } = await resolveSessionChat(session).catch((err: Error) => {
    throw new PostCardError(err.message);
  });
  if (mg.channel_type !== 'slack') throw new PostCardError('cards can only be posted into a Slack chat');
  const channel = stripSlack(mg.platform_id);
  const instance = mg.instance ?? mg.channel_type;
  const token = envValue(botTokenKeyForInstance(instance));
  if (!token) throw new PostCardError('Slack is not configured for this chat');

  const threadTs =
    threadTsFor(originThreadId, channel) ??
    threadTsFor(content.threadId, channel) ??
    threadTsFor(session.thread_id, channel);

  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new PostCardError('agent group not found');

  let template: Awaited<ReturnType<typeof findTemplate>>['template'];
  let data: Record<string, unknown>;
  try {
    template = (await findTemplate(resolveGroupFolderPath(group.folder), templateName)).template;
    data = validateData(template, content.data ?? {});
  } catch (err) {
    if (err instanceof TemplateError) throw new PostCardError(err.message);
    throw err;
  }
  if (template.source === undefined) throw new PostCardError('template has no OpenUI source');

  const existing = await getCardById(cardId);
  if (existing) {
    if (existing.meta?.sessionId !== session.id) throw new PostCardError('card id already in use');
    // Redelivery of a card that was already posted; finish a close the first attempt may have missed.
    const pending = await findReplaced(content.replaces, session, templateName);
    if (pending) await closeReplaced(pending, slackClientForToken(token));
    return;
  }

  const replaced = await findReplaced(content.replaces, session, templateName);
  const owner = replaced ? replaced.owner : (readInboundSender(session, content.inReplyTo) ?? '');
  const state = escapeEntities(data);
  try {
    await kit.render(template.source, state);
  } catch (err) {
    throw new PostCardError(`template ${templateName} could not be rendered: ${shortMessage(err)}`);
  }
  const client = slackClientForToken(token);
  await kit.postCard(client, { channel, ...(threadTs ? { threadTs } : {}) }, template.source, {
    owner,
    access: template.access,
    trusted: true,
    placeholder: false,
    state,
    meta: {
      kind: 'card',
      cardId,
      template: templateName,
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
      instance,
    },
  });
  // A card is a visible reply: stop the typing refresher from setting "Typing..." again, as delivery does after a chat message.
  pauseTypingRefreshAfterDelivery(session.id);
  if (replaced) await closeReplaced(replaced, client);
}

/** Close the replaced card with its own instance's client (fallback: `fallback`). A failure is logged only. */
async function closeReplaced(old: CardRecord, fallback: ReturnType<typeof slackClientForToken>): Promise<void> {
  try {
    const instance = old.meta?.instance;
    const oldToken = typeof instance === 'string' && instance !== '' ? envValue(botTokenKeyForInstance(instance)) : '';
    const client = oldToken ? slackClientForToken(oldToken) : fallback;
    await kit.closeCard(client, old.channel, old.ts, { note: 'Replaced by a newer version.' });
  } catch (err) {
    log.warn('slack-ui: could not close the replaced card', { ts: old.ts, err: String(err) });
  }
}

/**
 * The earlier card a new post replaces: it must exist, belong to this session, be a plain card of the
 * same template and still be open. Anything else is ignored with a warning and the new card posts
 * normally (with the normal owner). Never throws.
 */
async function findReplaced(replaces: unknown, session: Session, templateName: string) {
  if (replaces === undefined || replaces === null || replaces === '') return undefined;
  try {
    const old = typeof replaces === 'string' ? await getCardById(replaces) : undefined;
    if (old && old.meta?.sessionId === session.id && old.meta?.kind === 'card' && old.meta?.template === templateName) {
      if (!old.locked) return old;
      log.warn('slack-ui: ignoring replaces, that card is already closed; pass the most recent version', {
        cardId: replaces,
      });
      return undefined;
    }
  } catch (err) {
    log.warn('slack-ui: could not look up the card to replace', { err: String(err) });
    return undefined;
  }
  log.warn('slack-ui: ignoring replaces, no such card in this session');
  return undefined;
}

export async function handlePostCard(content: Record<string, unknown>, session: Session): Promise<void> {
  try {
    await postCard(content, session);
  } catch (err) {
    const reason =
      err instanceof PostCardError ||
      err instanceof CardRenderError ||
      (err instanceof Error && err.name === 'SlackApiError')
        ? err.message
        : 'unexpected error (see host log)';
    log.warn('slack-ui: post_card failed', { err: err instanceof Error ? err.message : String(err) });
    try {
      const answered =
        typeof content.inReplyTo === 'string' && content.inReplyTo !== '' ? content.inReplyTo : undefined;
      await notifyCardFailure(session, `post_card failed: ${reason}`, answered);
    } catch (notifyErr) {
      log.error('slack-ui: could not notify agent', { err: String(notifyErr) });
    }
  }
}

registerDeliveryAction(
  'post_card',
  handlePostCard,
  unguarded("posts only into the session's own chat; click rules come from the template, never from the agent"),
);
