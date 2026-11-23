/**
 * Clicks on kit cards. Registered with the chat bridge as a question action
 * handler: it claims only presses on cards the kit store holds for this Slack
 * app instance and passes everything else on. Presses on cards of the old
 * `ncu:` format get a private "no longer active" note. Never throws to the
 * bridge.
 */
import type { ActionEvent, Adapter } from 'chat';

import { registerQuestionActionHandler } from '../../channels/question-render-registry.js';
import { log } from '../../log.js';
import { kit, recoverKitError } from './kit.js';
import { slackClientForInstance } from './slack-client.js';

type Obj = Record<string, unknown>;

export const NO_LONGER_ACTIVE = 'This card is no longer active.';

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Channel and message ts of the message a press came from. */
export function locateMessage(raw: unknown): { channel: string; ts: string } | undefined {
  if (!isObj(raw)) return undefined;
  const container = isObj(raw.container) ? raw.container : {};
  const channelObj = isObj(raw.channel) ? raw.channel : {};
  const message = isObj(raw.message) ? raw.message : {};
  const channel = str(container.channel_id) ?? str(channelObj.id);
  const ts = str(container.message_ts) ?? str(message.ts);
  return channel && ts ? { channel, ts } : undefined;
}

async function tellNoLongerActive(event: ActionEvent, instance: string): Promise<void> {
  const client = slackClientForInstance(instance);
  const raw = isObj(event.raw) ? event.raw : {};
  const channel = locateMessage(raw)?.channel ?? (isObj(raw.channel) ? str(raw.channel.id) : undefined);
  const user = event.user?.userId;
  if (!client || !channel || !user) return;
  const container = isObj(raw.container) ? raw.container : {};
  const threadTs = str(container.thread_ts);
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text: NO_LONGER_ACTIVE,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (err) {
    log.warn('slack-ui: ephemeral failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleKitAction(event: ActionEvent, _adapter: Adapter, instance: string): Promise<boolean> {
  try {
    if (event.actionId.startsWith('ncu:')) {
      await tellNoLongerActive(event, instance);
      return true;
    }
    const at = locateMessage(event.raw);
    if (!at) return false;
    const card = await kit.getCard(at.channel, at.ts);
    if (!card) return false;
    if (card.meta?.instance !== instance) return false;

    const client = slackClientForInstance(instance);
    if (!client) {
      log.error('slack-ui: no bot token for instance', { instance });
      return true;
    }
    try {
      await kit.handleAction(client, event.raw);
    } catch (err) {
      await recoverKitError(err);
    }
    return true;
  } catch (err) {
    log.error('slack-ui: card action failed', { err: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

registerQuestionActionHandler(handleKitAction);
