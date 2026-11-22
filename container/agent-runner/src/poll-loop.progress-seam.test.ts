import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import {
  _resetProgressSeamForTesting,
  registerChatRowDecorator,
  registerProgressObserver,
  type ProgressEvent,
} from './progress-seam.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

const ROUTING = {
  platformId: 'channel-1',
  channelType: 'slack',
  threadId: 'thread-a',
  inReplyTo: 'request-a',
  taskRun: false,
};

function insertMessage(id: string, threadId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, 'channel-1', 'slack', ?, ?)`,
    )
    .run(id, new Date().toISOString(), threadId, JSON.stringify({ text: id }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function stubQuery(events: AsyncGenerator<ProviderEvent>, pushes: string[] = []): AgentQuery {
  return { push: (m) => void pushes.push(m), end: () => {}, abort: () => {}, events };
}

let seen: ProgressEvent[];

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
     VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
  );
  seen = [];
});

afterEach(() => {
  _resetProgressSeamForTesting();
  closeSessionDb();
});

describe('poll-loop progress seam', () => {
  it('sendToDestination writes the decorator\'s stream field into content and keeps text', async () => {
    registerChatRowDecorator((row) => {
      expect(row).toEqual({ platformId: 'channel-1', channelType: 'slack', threadId: 'thread-a', body: 'Hi there' });
      return { stream: 'stream-1', text: 'not this' };
    });
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text', text: '<message to="main">Hi there</message>' };
      yield { type: 'result', text: '' };
    }
    await processQuery(stubQuery(events()), ROUTING, ['request-a'], 'claude', undefined, 'prompt', undefined, true);
    const rows = getUndeliveredMessages().filter((r) => r.kind === 'chat');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toEqual({ stream: 'stream-1', text: 'Hi there' });
  });

  it('sendToDestination content is unchanged with no decorator', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text', text: '<message to="main">Hi there</message>' };
      yield { type: 'result', text: '' };
    }
    await processQuery(stubQuery(events()), ROUTING, ['request-a'], 'claude', undefined, 'prompt', undefined, true);
    const rows = getUndeliveredMessages().filter((r) => r.kind === 'chat');
    expect(rows[0].content).toBe(JSON.stringify({ text: 'Hi there' }));
  });

  it('handleEvent result emits turn_end done / error by isError', async () => {
    registerProgressObserver((e) => seen.push(e));
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '' };
      yield { type: 'result', text: null, isError: true, error: 'failed' };
    }
    await processQuery(stubQuery(events()), ROUTING, ['request-a'], 'claude', undefined, 'prompt', undefined, true);
    expect(seen.filter((e) => e.type === 'turn_end')).toEqual([
      { type: 'turn_end', outcome: 'done' },
      { type: 'turn_end', outcome: 'error' },
    ]);
  });

  it('each adopted batch emits turn_start with its routing and messages', async () => {
    registerProgressObserver((e) => seen.push(e));
    insertMessage('request-a', 'thread-a');
    const controller = new AbortController();
    const pushes: string[] = [];
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: () =>
        stubQuery(
          (async function* () {
            yield { type: 'result', text: '' } as ProviderEvent;
            insertMessage('request-b', 'thread-b');
            await waitFor(() => pushes.length === 1);
            yield { type: 'result', text: '' } as ProviderEvent;
            controller.abort();
          })(),
          pushes,
        ),
    };
    await runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
    const order = seen.map((e) => e.type);
    expect(order).toEqual(['turn_start', 'turn_end', 'turn_start', 'turn_end']);
    const starts = seen.filter((e): e is Extract<ProgressEvent, { type: 'turn_start' }> => e.type === 'turn_start');
    expect(starts[0].routing).toMatchObject({ threadId: 'thread-a', inReplyTo: 'request-a' });
    expect(starts[0].messages.map((m) => m.id)).toEqual(['request-a']);
    expect(starts[1].routing).toMatchObject({ threadId: 'thread-b', inReplyTo: 'request-b' });
    expect(starts[1].messages.map((m) => m.id)).toEqual(['request-b']);
  });
});
