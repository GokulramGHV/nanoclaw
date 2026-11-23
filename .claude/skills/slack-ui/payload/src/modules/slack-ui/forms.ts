/**
 * Form (modal) submits for kit cards. The kit puts the card's channel and ts
 * in the modal's hidden data; the token comes from the stored card's instance,
 * never from the form. The kit's field errors go back to Slack at once, and
 * the rest of the work (save, redraw, lock, event) runs after the reply.
 */
import type { Adapter, ModalResponse, ModalSubmitEvent } from 'chat';

import { registerModalSubmitHandler } from '../../channels/question-render-registry.js';
import { log } from '../../log.js';
import { FORM_CALLBACK_ID, kit, recoverKitError } from './kit.js';
import { slackClientForInstance } from './slack-client.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function handleKitFormSubmit(
  event: ModalSubmitEvent,
  _adapter: Adapter,
  instance: string,
): Promise<ModalResponse | undefined | false> {
  const raw = isObj(event.raw) ? event.raw : {};
  const view = isObj(raw.view) ? raw.view : undefined;
  if (!view || view.callback_id !== FORM_CALLBACK_ID) return false;

  let channel: string | undefined;
  let ts: string | undefined;
  try {
    const meta = JSON.parse(String(view.private_metadata ?? '')) as { m?: { channel?: unknown; ts?: unknown } };
    channel = typeof meta.m?.channel === 'string' ? meta.m.channel : undefined;
    ts = typeof meta.m?.ts === 'string' ? meta.m.ts : undefined;
  } catch {
    return false;
  }
  if (!channel || !ts) return false;

  const card = await kit.getCard(channel, ts);
  if (!card || card.meta?.instance !== instance) return false;
  const client = slackClientForInstance(instance);
  if (!client) {
    log.error('slack-ui: no bot token for instance', { instance });
    return false;
  }

  const result = await kit.handleViewSubmission(client, raw);
  if (!result.handled) return false;
  void result.done.catch((err) => recoverKitError(err));
  if (result.response) return { action: 'errors', errors: result.response.errors };
  return undefined;
}

registerModalSubmitHandler(handleKitFormSubmit);
