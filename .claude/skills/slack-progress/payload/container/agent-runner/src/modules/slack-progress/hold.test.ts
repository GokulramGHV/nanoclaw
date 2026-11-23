import { describe, expect, it } from 'bun:test';
import type { MessageInRow } from '../../db/messages-in.js';
import type { ChatRowInfo, ProgressEvent } from '../../progress-seam.js';
import { createHold, flushHoldOnCardTool } from './hold.js';
import { createProgressTracker } from './tracker.js';
import { createStreamer, type StreamAbortRow, type StreamAppendRow } from './streamer.js';

const row = (platformId: string, body: string, threadId: string | null = null): ChatRowInfo => ({
  platformId,
  channelType: 'slack',
  threadId,
  body,
});

function setup(open: { value: boolean }) {
  const written: string[] = [];
  const logs: string[] = [];
  const hold = createHold({ stepsOpen: () => open.value, log: (m) => logs.push(m) });
  const offer = (platformId: string, body: string, threadId: string | null = null) =>
    hold.offer(row(platformId, body, threadId), async () => void written.push(body));
  return { hold, offer, written, logs };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = (): ProgressEvent => ({ type: 'turn_start', routing: {} as never, messages: [] });
const tool = (name = 'Read'): ProgressEvent => ({ type: 'tool', name, input: {} });
const end: ProgressEvent = { type: 'turn_end', outcome: 'done' };

describe('mid-task message hold', () => {
  it('does not take a message when no steps are open', () => {
    const { offer } = setup({ value: false });
    expect(offer('slack:C1', 'hi')).toBe(false);
  });

  it('drops narration when the final reply is written normally', async () => {
    const open = { value: true };
    const { hold, offer, written, logs } = setup(open);
    hold.onEvent(start());
    expect(offer('slack:C1', 'Still working, redoing it')).toBe(true);
    hold.onEvent(tool());
    open.value = false;
    expect(offer('slack:C1', 'The result')).toBe(false);
    hold.onEvent(end);
    await flush();
    expect(written).toEqual([]);
    expect(logs.join(' ')).toContain('dropped 1');
  });

  it('writes the last held message when nothing came after it', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    offer('slack:C1', 'Step 1 done');
    hold.onEvent(tool());
    offer('slack:C1', 'Which repo should I use?');
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['Which repo should I use?']);
  });

  it('narration held before a tool call is written when nothing follows it', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    offer('slack:C1', 'Checking the logs');
    hold.onEvent(tool());
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['Checking the logs']);
  });

  it('a quiet tool (task list) does not turn held text into narration', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    offer('slack:C1', 'Result A');
    hold.onEvent(tool('TaskUpdate'));
    offer('slack:C1', 'Result B');
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['Result A', 'Result B']);
  });

  it('keeps the result when a short sign-off passes unheld after it, and writes the result first', async () => {
    const open = { value: true };
    const { hold, offer, written } = setup(open);
    hold.onEvent(start());
    offer('slack:C1', 'Narration');
    hold.onEvent(tool());
    offer('slack:C1', 'The full answer');
    open.value = false;
    // The sign-off is taken so that it lands after the result.
    expect(offer('slack:C1', 'Let me know if you want more detail.')).toBe(true);
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['The full answer', 'Let me know if you want more detail.']);
  });

  it('writes both parts of a two-part answer written after the last tool call', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    hold.onEvent(tool());
    offer('slack:C1', 'Part one');
    offer('slack:C1', 'Part two');
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['Part one', 'Part two']);
  });

  it('a message to another chat does not drop the held one', async () => {
    const open = { value: true };
    const { hold, offer, written } = setup(open);
    hold.onEvent(start());
    offer('slack:C1', 'Question for you');
    open.value = false;
    offer('slack:C2', 'note elsewhere');
    hold.onEvent({ type: 'turn_end', outcome: 'error' });
    await flush();
    expect(written).toEqual(['Question for you']);
  });

  it('a message in another thread of the same chat does not drop held narration', async () => {
    const open = { value: true };
    const { hold, offer, written } = setup(open);
    hold.onEvent(start());
    offer('slack:C1', 'Thread A progress', 'a');
    hold.onEvent(tool());
    open.value = false;
    expect(offer('slack:C1', 'Thread B answer', 'b')).toBe(false);
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['Thread A progress']);
  });

  it('a new turn settles anything left from a turn that never ended', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    offer('slack:C1', 'left over');
    hold.onEvent(start());
    await flush();
    expect(written).toEqual(['left over']);
  });

  it('a failed write is logged, not thrown', async () => {
    const logs: string[] = [];
    const hold = createHold({ stepsOpen: () => true, log: (m) => logs.push(m) });
    hold.onEvent(start());
    hold.offer(row('slack:C1', 'x'), async () => {
      throw new Error('db down');
    });
    hold.onEvent(end);
    await flush();
    expect(logs.join(' ')).toContain('db down');
  });

  it('a barrier writes the latest held message before the blocking write, and drops earlier narration', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    offer('slack:C1', 'Old narration');
    offer('slack:C1', 'I found three options: A, B, C');
    hold.onEvent(tool('mcp__nanoclaw__ask_user_question'));
    await hold.barrier('slack:C1');
    expect(written).toEqual(['I found three options: A, B, C']);
    hold.onEvent(end);
    await flush();
    expect(written).toEqual(['I found three options: A, B, C']);
  });

  it('a barrier for another chat writes nothing', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent(start());
    offer('slack:C1', 'held');
    await hold.barrier('slack:C2');
    expect(written).toEqual([]);
  });
});

describe('post_card tool event', () => {
  it('flushes the latest held message for the turn chat before the card is written', async () => {
    const { hold, offer, written } = setup({ value: true });
    const observer = flushHoldOnCardTool(hold, () => 'slack:C1');
    hold.onEvent(start());
    offer('slack:C1', 'Here is the form:');
    // The same event reaches every observer, hold first.
    const e = tool('mcp__nanoclaw__post_card');
    hold.onEvent(e);
    observer(e);
    await flush();
    expect(written).toEqual(['Here is the form:']);
  });

  it('ignores other tools and a turn with no chat', async () => {
    const { hold, offer, written } = setup({ value: true });
    const observer = flushHoldOnCardTool(hold, () => null);
    offer('slack:C1', 'held');
    observer(tool('mcp__nanoclaw__post_card'));
    observer(tool('Read'));
    await flush();
    expect(written).toEqual([]);
  });
});

describe('hold with the tracker (no plan shown means no hold)', () => {
  const DISPLAY = { id: 's1:wake-context:slack-progress:display:m1' } as MessageInRow;
  function compose(messages: MessageInRow[]) {
    const tracker = createProgressTracker({
      now: () => 1000,
      setTimer: () => () => {},
      send: () => {},
      enabled: () => true,
      newId: () => 't1',
    });
    const written: string[] = [];
    const hold = createHold({ stepsOpen: (p) => tracker.stepsOpen(p), log: () => {} });
    const emit = (e: ProgressEvent) => {
      tracker.onEvent(e);
      hold.onEvent(e);
    };
    emit({
      type: 'turn_start',
      routing: { platformId: 'C1', channelType: 'slack', threadId: 't', inReplyTo: null, taskRun: false },
      messages,
    });
    emit({
      type: 'todos',
      todos: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ],
    });
    const offer = (body: string) => hold.offer(row('C1', body), async () => void written.push(body));
    return { emit, offer, written };
  }

  it('an a2a-room turn (no display row) with open steps writes every message at once', async () => {
    const { emit, offer, written } = compose([]);
    expect(offer('@B please check X')).toBe(false);
    expect(offer('My summary')).toBe(false);
    emit(end);
    await flush();
    expect(written).toEqual([]);
  });

  it('a turn with the display row holds while steps are open', () => {
    const { offer } = compose([DISPLAY]);
    expect(offer('Still going')).toBe(true);
  });

  it('a block streamed before the task list is aborted when the hold takes its row', () => {
    const rows: (StreamAppendRow | StreamAbortRow)[] = [];
    const streamer = createStreamer({
      now: () => 0,
      setTimer: () => () => {},
      send: (r) => rows.push(r),
      enabled: () => true,
      newId: () => 's-1',
      resolve: () => ({ platformId: 'C1', channelType: 'slack' }),
    });
    const hold = createHold({
      stepsOpen: () => true,
      log: () => {},
      onHeld: (r) => streamer.dropFinished(r.platformId, r.body),
    });
    const msg = {
      id: 'm1',
      trigger: 1,
      kind: 'chat-sdk',
      channel_type: 'slack',
      on_wake: 0,
      content: JSON.stringify({ senderId: 'slack:U1' }),
    } as unknown as MessageInRow;
    streamer.onEvent({
      type: 'turn_start',
      routing: { platformId: 'C1', channelType: 'slack', threadId: 't', inReplyTo: null, taskRun: false } as never,
      messages: [msg],
    });
    // Text arrives before the task list exists: the stream opens, then the block ends.
    streamer.onEvent({ type: 'text_delta', text: '<message to="room">On it, here is my plan</message>' });
    // Force the batched append out by ending the block (flush happens on close).
    expect(rows.some((r) => r.action === 'stream_append')).toBe(true);
    // The task list arrives, then the host-side row is held.
    expect(hold.offer(row('C1', 'On it, here is my plan'), async () => {})).toBe(true);
    expect(rows.filter((r) => r.action === 'stream_abort')).toEqual([
      { action: 'stream_abort', streamId: 's-1', platformId: 'C1' },
    ]);
    // Once aborted it is no longer decorated, so the later write is a plain message.
    expect(streamer.decorate(row('C1', 'On it, here is my plan'))).toBeNull();
  });
});
