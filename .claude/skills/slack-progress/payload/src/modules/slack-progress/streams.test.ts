import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  botTokenKeyForInstance: (i: string) => (i === 'slack' ? 'SLACK_BOT_TOKEN' : 'SLACK_BOT_TOKEN_X'),
}));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));
vi.mock('../../delivery.js', () => ({ registerDeliveryAction: vi.fn(), registerChatDeliveryInterceptor: vi.fn() }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./settings.js', () => ({ isEnabled: vi.fn() }));
vi.mock('./db/progress.js', () => {
  const streams = new Map<string, any>();
  return {
    __streams: streams,
    getStream: vi.fn(async (id: string) => (streams.has(id) ? { ...streams.get(id) } : null)),
    upsertStream: vi.fn(async (s: any) => void streams.set(s.streamId, { ...s })),
  };
});

import { slackCall } from '../../channels/slack-lib.js';
import { registerChatDeliveryInterceptor, registerDeliveryAction } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import * as progressDb from './db/progress.js';
import { isEnabled } from './settings.js';
import { handleStreamAbort, handleStreamAppend, interceptStreamedReply, resetStreamState } from './streams.js';

const streams = (progressDb as unknown as { __streams: Map<string, any> }).__streams;
const call = vi.mocked(slackCall);
const env: Record<string, string | undefined> = {};
const session = { id: 's1', agent_group_id: 'ag1', messaging_group_id: 'mg1', thread_id: 'slack:C1:100.1' } as any;

const append = (over: Record<string, unknown> = {}) => ({
  action: 'stream_append',
  streamId: 'st1',
  platformId: 'slack:C1',
  threadId: 'slack:C1:100.1',
  recipient: 'U9',
  text: 'Hello',
  ...over,
});
const msg = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    kind: 'chat',
    channelType: 'slack',
    platformId: 'slack:C1',
    threadId: 'slack:C1:100.1',
    ...over,
  }) as any;
const methods = () => call.mock.calls.map((c) => c[1]);

function seedStream(over: Record<string, unknown> = {}) {
  streams.set('st1', {
    streamId: 'st1',
    sessionId: 's1',
    instance: 'slack',
    channelId: 'C1',
    threadTs: '100.1',
    streamTs: '300.1',
    status: 'open',
    sentText: 'Hello',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  streams.clear();
  resetStreamState();
  for (const k of Object.keys(env)) delete env[k];
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  vi.mocked(envValue).mockImplementation((k: string) => env[k]);
  vi.mocked(isEnabled).mockResolvedValue(true);
  vi.mocked(getMessagingGroup).mockResolvedValue({
    channel_type: 'slack',
    platform_id: 'slack:C1',
    instance: null,
  } as any);
  call.mockImplementation(async (_t, method) => {
    if (method === 'auth.test') return { ok: true, team_id: 'T1' };
    if (method === 'chat.startStream') return { ok: true, ts: '300.1' };
    return { ok: true };
  });
});

describe('registration', () => {
  it('registers both actions and the interceptor', async () => {
    vi.resetModules();
    await import('./streams.js');
    const names = vi.mocked(registerDeliveryAction).mock.calls.map((c) => c[0]);
    expect(names).toEqual(['stream_append', 'stream_abort']);
    expect(registerChatDeliveryInterceptor).toHaveBeenCalledTimes(1);
  });
});

describe('stream_append', () => {
  it('first append calls chat.startStream with channel, thread_ts, recipient_user_id, recipient_team_id and stores stream_ts', async () => {
    await handleStreamAppend(append(), session);
    const start = call.mock.calls.find((c) => c[1] === 'chat.startStream')!;
    expect(start[0]).toBe('xoxb-test');
    expect(start[2]).toMatchObject({
      channel: 'C1',
      thread_ts: '100.1',
      recipient_user_id: 'U9',
      recipient_team_id: 'T1',
      markdown_text: 'Hello',
    });
    expect(streams.get('st1')).toMatchObject({ streamTs: '300.1', status: 'open', sentText: 'Hello' });
  });

  it('team id comes from auth.test, cached per token', async () => {
    await handleStreamAppend(append(), session);
    await handleStreamAppend(append({ streamId: 'st2' }), session);
    expect(methods().filter((m) => m === 'auth.test')).toHaveLength(1);
    expect(methods().filter((m) => m === 'chat.startStream')).toHaveLength(2);
  });

  it('later appends call chat.appendStream in order, never concurrently', async () => {
    await handleStreamAppend(append(), session);
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    call.mockImplementation(async (_t, method, body: any) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(body.markdown_text);
      active--;
      return { ok: true };
    });
    await Promise.all([
      handleStreamAppend(append({ text: ' one' }), session),
      handleStreamAppend(append({ text: ' two' }), session),
      handleStreamAppend(append({ text: ' three' }), session),
    ]);
    expect(order).toEqual([' one', ' two', ' three']);
    expect(maxActive).toBe(1);
    expect(methods().slice(2)).toEqual(['chat.appendStream', 'chat.appendStream', 'chat.appendStream']);
    expect(streams.get('st1').sentText).toBe('Hello one two three');
  });

  it('channel id listed in SLACK_A2A_ROOMS: no stream, row marked failed', async () => {
    env.SLACK_A2A_ROOMS = 'C7, C1';
    await handleStreamAppend(append(), session);
    expect(call).not.toHaveBeenCalled();
    expect(streams.get('st1').status).toBe('failed');
  });

  it('disabled group: no Slack call', async () => {
    vi.mocked(isEnabled).mockResolvedValue(false);
    await handleStreamAppend(append(), session);
    expect(call).not.toHaveBeenCalled();
    expect(streams.size).toBe(0);
  });

  it('a Slack error marks the stream failed and later appends are ignored', async () => {
    call.mockImplementation(async (_t, method) => {
      if (method === 'auth.test') return { ok: true, team_id: 'T1' };
      throw new Error('boom');
    });
    await handleStreamAppend(append(), session);
    expect(streams.get('st1').status).toBe('failed');
    call.mockClear();
    await handleStreamAppend(append({ text: 'more' }), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('a row for another chat is ignored', async () => {
    await handleStreamAppend(append({ platformId: 'slack:C2' }), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('mentions in streamed text get the same treatment as the bridge gives Slack text', async () => {
    // The Slack bridge applies no text transform of its own (the adapter resolves
    // mentions inside postMessage), so streamed text is sent unchanged.
    await handleStreamAppend(append({ text: 'hi @alex and <@U2>' }), session);
    const start = call.mock.calls.find((c) => c[1] === 'chat.startStream')!;
    expect((start[2] as any).markdown_text).toBe('hi @alex and <@U2>');
  });
});

describe('interceptor', () => {
  it('open stream whose sent_text is a prefix of the final text appends the rest, calls chat.stopStream, returns stream_ts', async () => {
    seedStream();
    const id = await interceptStreamedReply(msg(), session, { text: 'Hello world', stream: 'st1' });
    expect(id).toBe('300.1');
    expect(call.mock.calls.map((c) => [c[1], (c[2] as any).markdown_text])).toEqual([
      ['chat.appendStream', ' world'],
      ['chat.stopStream', undefined],
    ]);
    expect(streams.get('st1').status).toBe('stopped');
  });

  it('exact text: stops without appending', async () => {
    seedStream();
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1' })).toBe('300.1');
    expect(methods()).toEqual(['chat.stopStream']);
  });

  it('failed stream returns null', async () => {
    seedStream({ status: 'failed', streamTs: null });
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('failed stream with a shown part ends it with a note and returns null', async () => {
    seedStream({ status: 'failed' });
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1' })).toBeNull();
    expect(call.mock.calls[0][1]).toBe('chat.stopStream');
    expect((call.mock.calls[0][2] as any).markdown_text).toMatch(/reply posted below/i);
  });

  it('unknown stream id returns null', async () => {
    expect(await interceptStreamedReply(msg(), session, { text: 'x', stream: 'nope' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('final text not starting with sent_text stops the stream with "reply posted below" and returns null', async () => {
    seedStream({ sentText: 'Hello' });
    expect(await interceptStreamedReply(msg(), session, { text: 'Goodbye', stream: 'st1' })).toBeNull();
    expect(methods()).toEqual(['chat.stopStream']);
    expect((call.mock.calls[0][2] as any).markdown_text).toMatch(/reply posted below/i);
    expect(streams.get('st1').status).toBe('failed');
  });

  it('stopStream failure returns null', async () => {
    seedStream();
    call.mockRejectedValue(new Error('boom'));
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1' })).toBeNull();
    expect(streams.get('st1').status).toBe('failed');
  });

  it('content without stream returns null', async () => {
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('a row with files returns null', async () => {
    seedStream();
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1', files: ['a.txt'] })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('a row with an operation (edit or reaction) returns null', async () => {
    seedStream();
    expect(
      await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1', operation: 'edit', messageId: '1' }),
    ).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('a destination that is not the session chat returns null', async () => {
    seedStream();
    expect(
      await interceptStreamedReply(msg({ platformId: 'slack:C2' }), session, { text: 'Hello', stream: 'st1' }),
    ).toBeNull();
    expect(
      await interceptStreamedReply(msg({ channelType: 'other' }), session, { text: 'Hello', stream: 'st1' }),
    ).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('disabled group returns null with no Slack call', async () => {
    seedStream();
    vi.mocked(isEnabled).mockResolvedValue(false);
    expect(await interceptStreamedReply(msg(), session, { text: 'Hello', stream: 'st1' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('waits for queued appends before finishing', async () => {
    await handleStreamAppend(append(), session);
    call.mockClear();
    const pending = handleStreamAppend(append({ text: ' there' }), session);
    const id = await interceptStreamedReply(msg(), session, { text: 'Hello there', stream: 'st1' });
    await pending;
    expect(id).toBe('300.1');
    expect(methods()).toEqual(['chat.appendStream', 'chat.stopStream']);
  });
});

describe('stream_abort', () => {
  it('stops the stream and deletes its message with chat.delete', async () => {
    seedStream();
    await handleStreamAbort({ action: 'stream_abort', streamId: 'st1', platformId: 'slack:C1' }, session);
    expect(methods()).toEqual(['chat.stopStream', 'chat.delete']);
    expect(call.mock.calls[1][2]).toMatchObject({ channel: 'C1', ts: '300.1' });
    expect(streams.get('st1').status).toBe('stopped');
  });

  it('unknown or never-started stream: no Slack call', async () => {
    await handleStreamAbort({ action: 'stream_abort', streamId: 'nope', platformId: 'slack:C1' }, session);
    seedStream({ streamTs: null });
    await handleStreamAbort({ action: 'stream_abort', streamId: 'st1', platformId: 'slack:C1' }, session);
    expect(call).not.toHaveBeenCalled();
  });
});
