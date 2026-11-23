/**
 * Writes a kit card event to the agent as a `card_event` webhook message. The
 * message id carries the card's save version, so a redelivered event is
 * written once.
 */
import type { CardEvent, CardRecord } from 'slack-ui-kit';

import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { kit, registerCardEventHandler } from './kit.js';

function isDuplicate(err: unknown): boolean {
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
  try {
    await writeSessionMessage(agentGroupId, sessionId, {
      id: `card-${cardId}-v${card.version}`,
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
          value: event.control.value ?? null,
          user: { id: event.user, name: '' },
          state: event.state,
          locked: event.locked !== undefined,
        },
      }),
    });
  } catch (err) {
    if (isDuplicate(err)) {
      log.debug('slack-ui: duplicate card event ignored', { cardId });
      return;
    }
    throw err;
  }
  const fresh = (await getSession(sessionId)) ?? session;
  await requestWake(fresh, 'interactive');
}

registerCardEventHandler('card', writeCardEvent);
