/**
 * Writes a kit card event to the agent as a `card_event` webhook message. The
 * message id carries Slack's action_ts for a click or the view id for a form
 * submit, so a redelivered event is written once.
 */
import type { CardEvent, CardRecord } from 'slack-ui-kit';

import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { kit, registerCardEventHandler } from './kit.js';

/**
 * What the raw Slack payload knows about one event and the card event does not:
 * the press's `action_ts` or the form's view id (they make the message id unique
 * per Slack event and stable across a redelivery) and the person's name. The
 * click or submit handler notes it just before the kit runs; the writer takes it.
 * Entries are removed after use or after 60 s.
 */
export type EventContext = { actionTs?: string; viewId?: string; userName?: string };

const CONTEXT_TTL_MS = 60_000;
const contexts = new Map<string, { ctx: EventContext; timer: ReturnType<typeof setTimeout> }>();

const contextKey = (channel: string, ts: string, user: string) => `${channel}:${ts}:${user}`;

export function noteEventContext(channel: string, ts: string, user: string, ctx: EventContext): void {
  const key = contextKey(channel, ts, user);
  const old = contexts.get(key);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => contexts.delete(key), CONTEXT_TTL_MS);
  timer.unref?.();
  contexts.set(key, { ctx, timer });
}

function takeContext(key: string): EventContext | undefined {
  return contexts.get(key)?.ctx;
}

/** The noted context for one event, removed on the way out. For handlers that write their own agent message. */
export function takeEventContext(channel: string, ts: string, user: string): EventContext | undefined {
  const key = contextKey(channel, ts, user);
  const ctx = takeContext(key);
  dropContext(key);
  return ctx;
}

function dropContext(key: string): void {
  const hit = contexts.get(key);
  if (hit) clearTimeout(hit.timer);
  contexts.delete(key);
}

/** Drop one leading `$` from each key of a plain object (state and form values); anything else passes through. */
function stripDollar(v: unknown): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k.startsWith('$') ? k.slice(1) : k, val]));
}

export function isDuplicate(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * `stored` is the card as saved after the click (the kit's `EventDeliveryError`
 * carries it on a retry); without it the card is read from the store.
 */
export async function writeCardEvent(event: CardEvent, stored?: CardRecord): Promise<void> {
  const cardId = str(event.meta?.cardId);
  const sessionId = str(event.meta?.sessionId);
  const agentGroupId = str(event.meta?.agentGroupId);
  if (!cardId || !sessionId || !agentGroupId) {
    log.warn('slack-ui: card event without host metadata, no agent message sent', { ts: event.card.ts });
    return;
  }
  const card = stored ?? (await kit.getCard(event.card.channel, event.card.ts));
  if (!card) {
    log.error('slack-ui: card missing for event, no agent message sent', { cardId });
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    log.error('slack-ui: card session missing, no agent message sent', { cardId, session: sessionId });
    return;
  }

  const channel = event.card.channel;
  const threadTs = event.card.threadTs;
  const key = contextKey(channel, event.card.ts, event.user);
  const ctx = takeContext(key);
  const id = ctx?.actionTs
    ? `card-${cardId}-${ctx.actionTs}`
    : ctx?.viewId
      ? `card-${cardId}-${ctx.viewId}-sub`
      : `card-${cardId}-v${card.version}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeSessionMessage(agentGroupId, sessionId, {
      id,
      kind: 'webhook',
      timestamp: new Date().toISOString(),
      platformId: `slack:${channel}`,
      channelType: 'slack',
      threadId: threadTs ? `slack:${channel}:${threadTs}` : null,
      content: JSON.stringify({
        source: 'slack-ui',
        event: 'card_event',
        payload: {
          cardId,
          template: str(event.meta?.template) ?? '',
          control: event.control.id,
          value: stripDollar(event.control.value ?? null),
          user: { id: event.user, name: ctx?.userName ?? '' },
          state: stripDollar(event.state),
          locked: event.locked !== undefined,
        },
      }),
    });
  } catch (err) {
    if (isDuplicate(err)) {
      log.debug('slack-ui: duplicate card event ignored', { cardId });
      dropContext(key);
      return;
    }
    throw err;
  }
  dropContext(key);
  const fresh = (await getSession(sessionId)) ?? session;
  await requestWake(fresh, 'interactive');
}

registerCardEventHandler('card', writeCardEvent);
