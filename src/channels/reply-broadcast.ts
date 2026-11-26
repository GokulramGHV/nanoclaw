/**
 * "Also send to the channel" for a Slack thread reply (`reply_broadcast: true`).
 * The Chat SDK's postMessage has no such option, so the bridge runs the post
 * inside `broadcastScope` and this wrapper, installed once on the Slack
 * client's `chat.postMessage`, adds the flag to calls made in that scope that
 * are thread replies (carry `thread_ts`). Anything else is left alone, so a
 * post to the channel itself, or another platform, ignores the request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const broadcastScope = new AsyncLocalStorage<{ broadcast: boolean }>();

const INSTALLED = Symbol.for('nanoclaw.replyBroadcastInstalled');

type PostFn = (args: Record<string, unknown>) => Promise<unknown>;
type ClientLike = { chat?: { postMessage?: PostFn } };

/** Wrap the adapter's Slack client once (the SDK posts through `_client`, older releases through `webClient`). */
export function installReplyBroadcast(adapter: object): void {
  const a = adapter as { _client?: ClientLike; webClient?: ClientLike };
  const chat = (a._client ?? a.webClient)?.chat as (ClientLike['chat'] & { [INSTALLED]?: boolean }) | undefined;
  if (!chat?.postMessage || chat[INSTALLED]) return;
  const post = chat.postMessage.bind(chat);
  chat.postMessage = (args) =>
    broadcastScope.getStore()?.broadcast && typeof args.thread_ts === 'string' && args.thread_ts !== ''
      ? post({ ...args, reply_broadcast: true })
      : post(args);
  chat[INSTALLED] = true;
}
