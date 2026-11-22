import { describe, expect, test } from 'bun:test';
import type { MessageInRow } from '../../db/messages-in.js';
import type { ProgressEvent } from '../../progress-seam.js';
import { createStreamer, type StreamAbortRow, type StreamAppendRow } from './streamer.js';

const CHAT = 'slack:C1';

function msg(over: Partial<MessageInRow> & { content?: unknown } = {}): MessageInRow {
  const { content, ...rest } = over;
  return {
    id: 'm1',
    seq: 1,
    kind: 'chat-sdk',
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id: CHAT,
    channel_type: 'slack',
    thread_id: 't1',
    content: JSON.stringify(content ?? { senderId: 'slack:U123', text: 'hi' }),
    source_session_id: null,
    on_wake: 0,
    ...rest,
  };
}

function start(
  messages: MessageInRow[] = [msg()],
  routing: Partial<{ threadId: string | null; taskRun: boolean; channelType: string | null }> = {},
): ProgressEvent {
  return {
    type: 'turn_start',
    routing: {
      platformId: CHAT,
      channelType: 'slack',
      threadId: 't1',
      inReplyTo: null,
      taskRun: false,
      ...routing,
    },
    messages,
  };
}

function setup(
  opts: { enabled?: boolean; resolveTo?: (to: string) => { platformId: string; channelType: string } | null } = {},
) {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const rows: (StreamAppendRow | StreamAbortRow)[] = [];
  let n = 0;
  const streamer = createStreamer({
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { at: t + ms, fn, live: true };
      timers.push(e);
      return () => {
        e.live = false;
      };
    },
    send: (r) => rows.push(r),
    enabled: () => opts.enabled ?? true,
    newId: () => `s-${++n}`,
    resolve: opts.resolveTo ?? (() => ({ platformId: CHAT, channelType: 'slack' })),
  });
  function advance(ms: number) {
    const target = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      t = next.at;
      next.fn();
    }
    t = target;
  }
  const text = (s: string) => streamer.onEvent({ type: 'text_delta', text: s });
  return { streamer, rows, advance, text };
}

const chatRow = { platformId: CHAT, channelType: 'slack', threadId: 't1', body: 'x' };
const rowFor = (body: string) => ({ ...chatRow, body });

describe('streamer', () => {
  test("streams when to resolves to the turn's own slack chat with a thread and one human sender", () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">hello</message>');
    s.advance(500);
    expect(s.rows).toEqual([
      { action: 'stream_append', streamId: 's-1', platformId: CHAT, threadId: 't1', recipient: 'U123', text: 'hello' },
    ]);
  });

  test('no stream when threadId is null', () => {
    const s = setup();
    s.streamer.onEvent(start([msg()], { threadId: null }));
    s.text('<message to="room">hello</message>');
    s.advance(1000);
    expect(s.rows).toEqual([]);
  });

  test('no stream when to resolves elsewhere or not at all', () => {
    for (const resolveTo of [
      () => ({ platformId: 'slack:C2', channelType: 'slack' }),
      () => ({ platformId: CHAT, channelType: 'telegram' }),
      () => null,
    ]) {
      const s = setup({ resolveTo });
      s.streamer.onEvent(start());
      s.text('<message to="room">hello</message>');
      s.advance(1000);
      expect(s.rows).toEqual([]);
      expect(s.streamer.decorate(chatRow)).toBeNull();
    }
  });

  test('no stream for bot sender (content.author.isBot or senderId starting slack:bot:), task kind, on_wake row, or two distinct senders', () => {
    const cases: MessageInRow[][] = [
      [msg({ content: { author: { userId: 'U9', isBot: true }, text: 'x' } })],
      [msg({ content: { senderId: 'slack:bot:B1', text: 'x' } })],
      [msg({ kind: 'task' })],
      [msg({ on_wake: 1 })],
      [msg(), msg({ id: 'm2', content: { senderId: 'slack:U456', text: 'x' } })],
    ];
    for (const messages of cases) {
      const s = setup();
      s.streamer.onEvent(start(messages));
      s.text('<message to="room">hello</message>');
      s.advance(1000);
      expect(s.rows).toEqual([]);
    }
  });

  test('context-only rows (trigger 0) do not count as senders', () => {
    const s = setup();
    s.streamer.onEvent(start([msg(), msg({ id: 'm2', trigger: 0, content: { senderId: 'slack:U456', text: 'x' } })]));
    s.text('<message to="room">hello</message>');
    s.advance(500);
    expect(s.rows.length).toBe(1);
  });

  test('no stream when enabled() false', () => {
    const s = setup({ enabled: false });
    s.streamer.onEvent(start());
    s.text('<message to="room">hello</message>');
    s.advance(1000);
    expect(s.rows).toEqual([]);
  });

  test('text batched to one row per 500 ms', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">a');
    s.advance(200);
    s.text('b');
    s.advance(200);
    s.text('c');
    expect(s.rows).toEqual([]);
    s.advance(100);
    expect(s.rows.map((r) => (r as StreamAppendRow).text)).toEqual(['abc']);
    s.text('d');
    s.advance(500);
    expect(s.rows.map((r) => (r as StreamAppendRow).text)).toEqual(['abc', 'd']);
  });

  test('recipient is the raw platform user id', () => {
    const s = setup();
    s.streamer.onEvent(start([msg({ content: { author: { userId: 'U777' }, text: 'x' } })]));
    s.text('<message to="room">hi</message>');
    s.advance(500);
    expect((s.rows[0] as StreamAppendRow).recipient).toBe('U777');
  });

  test('decorate returns {stream: id} for the closed block whose text matches the row body, oldest match first per platformId', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">one</message><message to="room">one</message><message to="room">two</message>');
    s.advance(500);
    expect(s.streamer.decorate(rowFor('one'))).toEqual({ stream: 's-1' });
    expect(s.streamer.decorate(rowFor('one'))).toEqual({ stream: 's-2' });
    expect(s.streamer.decorate(rowFor(' two '))).toEqual({ stream: 's-3' });
    expect(s.streamer.decorate(rowFor('one'))).toBeNull();
  });

  test('decorate returns null for a block that never streamed', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room"></message><message to="room">real</message>');
    s.advance(500);
    expect(s.streamer.decorate(rowFor(''))).toBeNull();
    expect(s.streamer.decorate(rowFor('real'))).toEqual({ stream: 's-2' });
    expect(s.rows.filter((r) => r.action === 'stream_abort')).toEqual([]);
  });

  test('two blocks in one turn get distinct stream ids in order', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">one</message> aside <message to="room">two</message>');
    s.advance(500);
    expect(s.rows.map((r) => [r.streamId, (r as StreamAppendRow).text])).toEqual([
      ['s-1', 'one'],
      ['s-2', 'two'],
    ]);
  });

  test('pending text is flushed before close', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">quick</message>');
    expect(s.rows.map((r) => (r as StreamAppendRow).text)).toEqual(['quick']);
  });

  test('text outside a message is never sent and a turn_end with no open turn is ignored', () => {
    const s = setup();
    s.streamer.onEvent({ type: 'turn_end', outcome: 'done' });
    s.streamer.onEvent(start());
    s.text('private notes <internal>x</internal>');
    s.advance(1000);
    s.streamer.onEvent({ type: 'turn_end', outcome: 'done' });
    expect(s.rows).toEqual([]);
  });

  test('a closed block whose row never comes is aborted at turn_end', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">dup</message>');
    s.streamer.onEvent({ type: 'turn_end', outcome: 'done' });
    expect(s.rows.filter((r) => r.action === 'stream_abort')).toEqual([
      { action: 'stream_abort', streamId: 's-1', platformId: CHAT },
    ]);
    expect(s.streamer.decorate(rowFor('dup'))).toBeNull();
  });

  test('earlier unmatched blocks are aborted when a later one matches', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">skipped</message><message to="room">kept</message>');
    expect(s.streamer.decorate(rowFor('kept'))).toEqual({ stream: 's-2' });
    expect(s.rows.filter((r) => r.action === 'stream_abort')).toEqual([
      { action: 'stream_abort', streamId: 's-1', platformId: CHAT },
    ]);
    s.streamer.onEvent({ type: 'turn_end', outcome: 'done' });
    expect(s.rows.filter((r) => r.action === 'stream_abort').length).toBe(1);
  });

  test('internal spans do not stream and are stripped before matching', () => {
    const s = setup();
    s.streamer.onEvent(start());
    s.text('<message to="room">a<Internal>secret</Internal>b</message>');
    expect(s.rows.map((r) => (r as StreamAppendRow).text)).toEqual(['ab']);
    expect(s.streamer.decorate(rowFor('a<internal note="z">q</internal>b'))).toEqual({ stream: 's-1' });
  });
});
