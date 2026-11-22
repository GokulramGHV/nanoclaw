/**
 * `post_card` delivery action: post an interactive card into the session's
 * own Slack chat. Order: find + validate + fill the template, insert the
 * ui_cards row, render, post, record the message ts. A failed post removes
 * the row again. The handler never throws to delivery; every failure becomes
 * a `post_card failed: ...` notice to the agent (path-free, token-free).
 */
import path from 'node:path';

import Database from 'better-sqlite3';

import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/types.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/primitive.js';
import { deleteCard, getCard, insertCard, setMessageTs } from './db/ui-cards.js';
import { renderCard } from './render.js';
import { fillTemplate, findTemplate, TemplateError, validateData } from './template.js';

const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class PostCardError extends Error {}

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

/** A row that can name an owner: a triggering chat message or slack-ui card_event. */
function isOwnerRow(row: InboundRow): boolean {
  if (row.trigger !== 1) return false;
  return row.kind === 'chat' || row.kind === 'chat-sdk' || isCardEvent(row, parseContent(row));
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
  if (isCardEvent(row, content)) {
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
 * triggering chat message or slack-ui card_event. A host system notice (such
 * as `post_card failed`) names no person; the agent replying to one is still
 * answering whoever engaged it before, so the owner is the sender of the
 * latest earlier owner row. There is no mailbox API to
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
    const row = db
      .prepare('SELECT kind, content, seq, "trigger" AS trigger FROM messages_in WHERE id = ?')
      .get(messageId) as InboundRow | undefined;
    if (!row) return null;
    if (isOwnerRow(row) && !isSystemNotice(row)) return senderOf(row);
    if (row.seq === null) return null;
    if (isSystemNotice(row)) {
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
  } catch (err) {
    log.debug('slack-ui: could not read inbound sender', { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    db?.close();
  }
}

async function postCard(content: Record<string, unknown>, session: Session): Promise<void> {
  const { cardId, template: templateName } = content;
  if (typeof cardId !== 'string' || !CARD_ID_RE.test(cardId)) throw new PostCardError('invalid cardId');
  if (typeof templateName !== 'string' || templateName === '') throw new PostCardError('template is required');

  if (!session.messaging_group_id) throw new PostCardError('this session has no chat to post into');
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) throw new PostCardError('this session has no chat to post into');
  if (mg.channel_type !== 'slack') throw new PostCardError('cards can only be posted into a Slack chat');
  const channel = stripSlack(mg.platform_id);
  const instance = mg.instance ?? mg.channel_type;
  const token = envValue(botTokenKeyForInstance(instance));
  if (!token) throw new PostCardError('Slack is not configured for this chat');

  const threadTs = threadTsFor(content.threadId, channel) ?? threadTsFor(session.thread_id, channel);

  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new PostCardError('agent group not found');

  let filled: ReturnType<typeof fillTemplate>;
  let template: Awaited<ReturnType<typeof findTemplate>>['template'];
  let data: Record<string, unknown>;
  try {
    template = (await findTemplate(resolveGroupFolderPath(group.folder), templateName)).template;
    data = validateData(template, content.data ?? {});
    filled = fillTemplate(template, data);
  } catch (err) {
    if (err instanceof TemplateError) throw new PostCardError(err.message);
    throw err;
  }

  const existing = await getCard(cardId);
  if (existing) {
    if (existing.sessionId !== session.id) throw new PostCardError('card id already in use');
    if (existing.messageTs) return; // redelivery of a card that was already posted
    await deleteCard(cardId); // an earlier attempt died mid-post
  }

  await insertCard({
    id: cardId,
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    instance,
    channelId: channel,
    threadTs,
    ownerUserId: readInboundSender(session, content.inReplyTo),
    templateName,
    template,
    data,
    state: filled.initialState,
  });

  let ts: string;
  try {
    const row = await getCard(cardId);
    if (!row) throw new PostCardError('card row missing after insert');
    const { text, blocks } = renderCard(row);
    const res = await slackCall(
      token,
      'chat.postMessage',
      { channel, text, blocks, ...(threadTs ? { thread_ts: threadTs } : {}) },
      'post_card',
    );
    if (typeof res.ts !== 'string') throw new PostCardError('Slack did not return a message timestamp');
    ts = res.ts;
  } catch (err) {
    await deleteCard(cardId).catch(() => {});
    throw err;
  }

  // Slack accepted the post: the message exists, so never delete the row or
  // report failure from here on. Retry the save once, then leave it to the log.
  const saveFailed = (err: unknown) =>
    log.error('slack-ui: card posted but saving its message ts failed', {
      cardId,
      ts,
      err: err instanceof Error ? err.message : String(err),
    });
  try {
    await setMessageTs(cardId, ts);
  } catch (first) {
    saveFailed(first);
    try {
      await setMessageTs(cardId, ts);
    } catch (second) {
      saveFailed(second);
    }
  }
}

export async function handlePostCard(content: Record<string, unknown>, session: Session): Promise<void> {
  try {
    await postCard(content, session);
  } catch (err) {
    const reason =
      err instanceof PostCardError || (err instanceof Error && err.name === 'SlackApiError')
        ? err.message
        : 'unexpected error (see host log)';
    log.warn('slack-ui: post_card failed', { err: err instanceof Error ? err.message : String(err) });
    try {
      await notifyAgent(session, `post_card failed: ${reason}`);
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
