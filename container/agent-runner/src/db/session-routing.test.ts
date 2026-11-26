/**
 * Thread resolution for sends from a task run. A task row has no route of its
 * own; the route it was created from rides in its content.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { resolveDestinationThread } from './session-routing.js';

function seedSessionRouting(threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, NULL, NULL, ?)',
  ).run(threadId);
}

let seq = 0;
function seedTask(seriesId: string, content: object | string, id = `task-${seq}`): void {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, series_id, content)
       VALUES (?, ?, 'task', ?, 'pending', ?, ?)`,
    )
    .run(id, seq, new Date().toISOString(), seriesId, typeof content === 'string' ? content : JSON.stringify(content));
}

function seedChat(id: string, channelType: string, platformId: string, threadId: string | null): void {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'completed', ?, ?, ?, '{"text":"hi"}')`,
    )
    .run(id, seq, new Date().toISOString(), platformId, channelType, threadId);
}

const originRoute = { channelType: 'slack', platformId: 'C1', threadId: '111.222' };

beforeEach(() => {
  initTestSessionDb();
  seq = 0;
});

afterEach(() => closeSessionDb());

describe('resolveDestinationThread in a task session', () => {
  test('a send to the origin channel lands in the origin thread', () => {
    seedSessionRouting('system:tasks:watch-a1b2');
    seedTask('watch-a1b2', { prompt: 'p', script: null, originSessionId: 's1', originRoute });
    expect(resolveDestinationThread('slack', 'C1')).toEqual({ threadId: '111.222', inReplyTo: null });
  });

  test('uses the newest occurrence of the series', () => {
    seedSessionRouting('system:tasks:watch-a1b2');
    seedTask('watch-a1b2', { prompt: 'p', originRoute: { ...originRoute, threadId: 'old' } });
    seedTask('watch-a1b2', { prompt: 'p', originRoute });
    expect(resolveDestinationThread('slack', 'C1')?.threadId).toBe('111.222');
  });

  test('an origin route without a thread resolves to the top level', () => {
    seedSessionRouting('system:tasks:watch-a1b2');
    seedTask('watch-a1b2', { prompt: 'p', originRoute: { ...originRoute, threadId: null } });
    expect(resolveDestinationThread('slack', 'C1')).toEqual({ threadId: null, inReplyTo: null });
  });

  test('another channel resolves as it does without an origin route', () => {
    seedSessionRouting('system:tasks:watch-a1b2');
    seedTask('watch-a1b2', { prompt: 'p', originRoute });
    expect(resolveDestinationThread('slack', 'C2')).toBeNull();
    expect(resolveDestinationThread('telegram', 'C1')).toBeNull();
  });

  test('a task without an origin route, or with legacy or malformed content, resolves to null', () => {
    seedSessionRouting('system:tasks:a-1111');
    seedTask('a-1111', { prompt: 'p', script: null, originSessionId: null });
    expect(resolveDestinationThread('slack', 'C1')).toBeNull();

    seedSessionRouting('system:tasks:b-2222');
    seedTask('b-2222', 'plain legacy prompt');
    expect(resolveDestinationThread('slack', 'C1')).toBeNull();

    seedSessionRouting('system:tasks:c-3333');
    seedTask('c-3333', { prompt: 'p', originRoute: { channelType: 'slack', platformId: 'C1', threadId: 5 } });
    expect(resolveDestinationThread('slack', 'C1')).toBeNull();
  });

  test('an inbound route for the channel still wins', () => {
    seedSessionRouting('system:tasks:watch-a1b2');
    seedTask('watch-a1b2', { prompt: 'p', originRoute });
    seedChat('in-1', 'slack', 'C1', '999.000');
    expect(resolveDestinationThread('slack', 'C1')).toEqual({ threadId: '999.000', inReplyTo: 'in-1' });
  });
});

describe('resolveDestinationThread outside a task session', () => {
  test('ignores task content even when it names an origin route', () => {
    seedSessionRouting('chat-thread');
    seedTask('watch-a1b2', { prompt: 'p', originRoute });
    expect(resolveDestinationThread('slack', 'C1')).toBeNull();
  });
});
