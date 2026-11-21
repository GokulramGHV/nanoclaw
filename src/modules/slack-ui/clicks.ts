/**
 * Click handling for `ncu:` cards: who may press, locking on submit, and
 * telling the agent. Order matters: load the card, check the rule (a group
 * rule may call Slack), `tryLock` for a submit control, then any Slack update,
 * then the agent message. Nothing is awaited between `tryLock` and the
 * decision to refuse the loser.
 */
import type { ActionEvent, Adapter } from 'chat';

import { registerQuestionActionHandler } from '../../channels/question-render-registry.js';
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { getSession } from '../../db/sessions.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { getCard, tryLock, updateState, type UiCard } from './db/ui-cards.js';
import { mergeState, parseActionId, renderCard, stateFromPayload, type CardState } from './render.js';
import { canPress, createGroupCache, refusalText, ruleFor } from './rules.js';

type Obj = Record<string, unknown>;

const NO_LONGER_ACTIVE = 'This card is no longer active.';
const ALREADY_SUBMITTED = 'This was already submitted.';

const groupCaches = new Map<string, (groupId: string) => Promise<string[]>>();

function groupMembersFor(token: string): (groupId: string) => Promise<string[]> {
  let cache = groupCaches.get(token);
  if (!cache) {
    cache = createGroupCache(token);
    groupCaches.set(token, cache);
  }
  return cache;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Keep only the payload entries whose action id belongs to `cardId`. */
function ownPayload(raw: unknown, cardId: string): unknown {
  if (!isObj(raw)) return {};
  const mine = (id: unknown): boolean => typeof id === 'string' && parseActionId(id)?.cardId === cardId;
  const out: Obj = {};
  if (Array.isArray(raw.actions)) {
    out.actions = raw.actions.filter((a) => isObj(a) && mine(a.action_id));
  }
  if (isObj(raw.state) && isObj(raw.state.values)) {
    const values: Obj = {};
    for (const [blockId, block] of Object.entries(raw.state.values)) {
      if (!isObj(block)) continue;
      values[blockId] = Object.fromEntries(Object.entries(block).filter(([id]) => mine(id)));
    }
    out.state = { values };
  }
  return out;
}

async function ephemeral(
  token: string,
  channel: string,
  user: string,
  threadTs: string | undefined,
  text: string,
): Promise<void> {
  try {
    await slackCall(token, 'chat.postEphemeral', { channel, user, text, thread_ts: threadTs }, 'slack-ui-ephemeral');
  } catch (err) {
    log.warn('slack-ui: ephemeral failed', { err: errMsg(err) });
  }
}

async function redraw(token: string, card: UiCard): Promise<void> {
  if (!card.messageTs) return;
  try {
    const { text, blocks } = renderCard(card);
    await slackCall(
      token,
      'chat.update',
      { channel: card.channelId, ts: card.messageTs, text, blocks },
      'slack-ui-update',
    );
  } catch (err) {
    log.warn('slack-ui: chat.update failed', { card: card.id, err: errMsg(err) });
  }
}

function isDuplicate(err: unknown): boolean {
  const code = isObj(err) ? err.code : undefined;
  const msg = errMsg(err);
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

async function notifyAgent(
  card: UiCard,
  control: string,
  merged: CardState,
  event: ActionEvent,
  raw: Obj,
  userId: string,
  locked: boolean,
): Promise<void> {
  const firstAction = Array.isArray(raw.actions) && isObj(raw.actions[0]) ? raw.actions[0] : undefined;
  const rawValue = firstAction && typeof firstAction.value === 'string' ? firstAction.value : null;
  const value = Object.prototype.hasOwnProperty.call(merged, control) ? merged[control] : rawValue;
  const session = await getSession(card.sessionId);
  if (!session) {
    log.error('slack-ui: card session missing, no agent message sent', { card: card.id, session: card.sessionId });
    return;
  }
  const actionTs = typeof raw.action_ts === 'string' && raw.action_ts ? raw.action_ts : String(Date.now());
  try {
    await writeSessionMessage(card.agentGroupId, card.sessionId, {
      id: `card-${card.id}-${actionTs}`,
      kind: 'webhook',
      timestamp: new Date().toISOString(),
      platformId: `slack:${card.channelId}`,
      channelType: 'slack',
      threadId: card.threadTs ? `slack:${card.channelId}:${card.threadTs}` : null,
      content: JSON.stringify({
        source: 'slack-ui',
        event: 'card_event',
        payload: {
          cardId: card.id,
          template: card.templateName,
          control,
          value,
          user: { id: userId, name: event.user.userName || event.user.fullName || '' },
          state: merged,
          locked,
        },
      }),
    });
  } catch (err) {
    if (isDuplicate(err)) {
      log.debug('slack-ui: duplicate click delivery ignored', { card: card.id });
    } else {
      log.error('slack-ui: writing card event failed', { card: card.id, err: errMsg(err) });
    }
    return;
  }
  const fresh = (await getSession(card.sessionId)) ?? session;
  await requestWake(fresh, 'interactive');
}

export async function handleCardAction(event: ActionEvent, _adapter: Adapter, instance: string): Promise<boolean> {
  const parsed = parseActionId(event.actionId);
  if (!parsed) return false;
  const { cardId, control } = parsed;

  const token = envValue(botTokenKeyForInstance(instance));
  if (!token) {
    log.error('slack-ui: no bot token for instance', { instance });
    return true;
  }

  const raw: Obj = isObj(event.raw) ? event.raw : {};
  const userId = event.user.userId;

  try {
    const card = await getCard(cardId);
    if (!card || card.instance !== instance) {
      const channel = isObj(raw.channel) && typeof raw.channel.id === 'string' ? raw.channel.id : undefined;
      const threadTs =
        isObj(raw.container) && typeof raw.container.thread_ts === 'string' ? raw.container.thread_ts : undefined;
      if (channel) await ephemeral(token, channel, userId, threadTs, NO_LONGER_ACTIVE);
      return true;
    }
    const threadTs = card.threadTs ?? undefined;

    if (card.locked) {
      await ephemeral(token, card.channelId, userId, threadTs, ALREADY_SUBMITTED);
      return true;
    }

    const rule = ruleFor(card.template, control);
    if (!(await canPress(rule, userId, card.ownerUserId, groupMembersFor(token)))) {
      await ephemeral(token, card.channelId, userId, threadTs, refusalText(rule, card.ownerUserId));
      await redraw(token, card);
      return true;
    }

    const merged = mergeState(card.state as CardState, stateFromPayload(ownPayload(raw, cardId)));

    if (!rule.submit) {
      await updateState(card.id, merged);
      const actions = Array.isArray(raw.actions) ? raw.actions : [];
      const clicked = actions.find((a) => isObj(a) && a.action_id === event.actionId) ?? actions[0];
      const isButton = isObj(clicked) && clicked.type === 'button';
      if (rule.notify ?? isButton) await notifyAgent(card, control, merged, event, raw, userId, false);
      return true;
    }

    if (!(await tryLock(card.id, userId))) {
      await ephemeral(token, card.channelId, userId, threadTs, ALREADY_SUBMITTED);
      return true;
    }
    await updateState(card.id, merged);
    const lockedCard: UiCard = {
      ...card,
      state: merged,
      locked: true,
      lockedBy: userId,
      lockedAt: new Date().toISOString(),
    };
    await redraw(token, lockedCard);
    if (rule.notify !== false) await notifyAgent(card, control, merged, event, raw, userId, true);
    return true;
  } catch (err) {
    log.error('slack-ui: card action failed', { card: cardId, err: errMsg(err) });
    return true;
  }
}

registerQuestionActionHandler(handleCardAction);
