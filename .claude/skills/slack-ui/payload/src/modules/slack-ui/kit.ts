/**
 * The one slack-ui-kit instance for the host. Its store is the central
 * database. Card events route by the card's `meta.kind` to a handler that a
 * module registers: this module registers `card`, the ask module registers
 * `ask`.
 */
import './telemetry.js';

import { createSlackKit, EventDeliveryError, type CardEvent, type CardRecord, type FormMeta } from 'slack-ui-kit';

import { log } from '../../log.js';
import { KitCardStore } from './db/kit-cards.js';

export type CardEventHandler = (event: CardEvent, card?: CardRecord) => Promise<void> | void;

const handlers = new Map<string, CardEventHandler>();

export function registerCardEventHandler(kind: string, handler: CardEventHandler): void {
  handlers.set(kind, handler);
}

/** Send one event to the handler for its card kind. `card` is the stored card when the caller has it. */
export async function routeCardEvent(event: CardEvent, card?: CardRecord): Promise<void> {
  const kind = event.meta?.kind;
  const handler = typeof kind === 'string' ? handlers.get(kind) : undefined;
  if (!handler) {
    log.warn('slack-ui: card event has no handler', { kind, channel: event.card.channel, ts: event.card.ts });
    return;
  }
  await handler(event, card);
}

/**
 * When the kit reports that `onEvent` threw, the click is already saved. Log it
 * and send the event once more; the handlers write idempotently. Any other
 * error is logged. Never throws.
 */
export async function recoverKitError(err: unknown): Promise<void> {
  if (err instanceof EventDeliveryError) {
    log.error('slack-ui: card event delivery failed, retrying once', {
      channel: err.event.card.channel,
      ts: err.event.card.ts,
      err: err.cause instanceof Error ? err.cause.message : String(err.cause),
    });
    try {
      await routeCardEvent(err.event, err.card);
    } catch (retryErr) {
      log.error('slack-ui: card event retry failed', {
        channel: err.event.card.channel,
        ts: err.event.card.ts,
        err: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }
    return;
  }
  log.error('slack-ui: card interaction failed', { err: err instanceof Error ? err.message : String(err) });
}

export const FORM_CALLBACK_ID = 'ncu_form';

export const kit = createSlackKit({
  store: new KitCardStore(),
  quiet: true,
  form: {
    callbackId: FORM_CALLBACK_ID,
    wrapMeta: (m) => JSON.stringify({ m }),
    unwrapMeta: (s) => (JSON.parse(s) as { m: FormMeta }).m,
  },
  onEvent: (event) => routeCardEvent(event),
});
