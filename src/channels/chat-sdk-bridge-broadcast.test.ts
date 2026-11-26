/**
 * `alsoToChannel` on a text delivery: a Slack thread reply is posted with
 * `reply_broadcast: true` on its first part; a post to the channel itself,
 * another platform, or a message without the flag is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ChannelAdapter } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

/** An adapter whose postMessage goes through a Slack-like client, as the real one does. */
function fakeAdapter(name: string) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true };
      },
    },
  };
  const adapter = {
    name,
    _client: client,
    initialize: async () => {},
    postMessage: async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      const [, channel, ts] = threadId.split(':');
      await client.chat.postMessage({
        channel,
        ...(ts ? { thread_ts: ts } : {}),
        text: (message as { markdown: string }).markdown,
      });
      return { id: 'id', threadId, raw: {} };
    },
  } as unknown as Adapter;
  return { adapter, calls };
}

const hostConfig = { onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} };

async function bridgeFor(adapter: Adapter, maxTextLength?: number): Promise<ChannelAdapter> {
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true, maxTextLength });
  await bridge.setup(hostConfig);
  return bridge;
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(() => closeDb());

const send = (b: ChannelAdapter, thread: string, content: Record<string, unknown>) =>
  b.deliver('slack:C1', thread, { kind: 'chat-sdk', content });

describe('alsoToChannel', () => {
  it('broadcasts a Slack thread reply', async () => {
    const { adapter, calls } = fakeAdapter('slack');
    await send(await bridgeFor(adapter), 'slack:C1:100.1', { text: 'Deployment Complete!', alsoToChannel: true });
    expect(calls).toEqual([{ channel: 'C1', thread_ts: '100.1', text: 'Deployment Complete!', reply_broadcast: true }]);
  });

  it('ignores it for a post to the channel itself and for a message without the flag', async () => {
    const { adapter, calls } = fakeAdapter('slack');
    const b = await bridgeFor(adapter);
    await b.deliver('slack:C1', null, { kind: 'chat-sdk', content: { text: 'top', alsoToChannel: true } });
    await send(b, 'slack:C1:100.1', { text: 'plain' });
    expect(calls.map((c) => c.reply_broadcast)).toEqual([undefined, undefined]);
  });

  it('does not leak into a later post in the same bridge', async () => {
    const { adapter, calls } = fakeAdapter('slack');
    const b = await bridgeFor(adapter);
    await send(b, 'slack:C1:100.1', { text: 'a', alsoToChannel: true });
    await send(b, 'slack:C1:100.1', { text: 'b' });
    expect(calls.map((c) => c.reply_broadcast)).toEqual([true, undefined]);
  });

  it('broadcasts only the first part of a split reply', async () => {
    const { adapter, calls } = fakeAdapter('slack');
    await send(await bridgeFor(adapter, 10), 'slack:C1:100.1', { text: 'aaaaaaaa bbbbbbbb cccccccc', alsoToChannel: true });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((c) => c.reply_broadcast === true)).toEqual(calls.map((_, i) => i === 0));
  });

  it('is ignored on other platforms', async () => {
    const { adapter, calls } = fakeAdapter('telegram');
    await send(await bridgeFor(adapter), 'telegram:C1:100.1', { text: 'hi', alsoToChannel: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('reply_broadcast');
  });
});
