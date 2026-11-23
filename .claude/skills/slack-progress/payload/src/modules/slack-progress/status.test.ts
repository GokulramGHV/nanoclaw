import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({ slackCall: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../typing/index.js', () => ({ pauseTypingRefreshAfterDelivery: vi.fn() }));
const previewHooks = vi.hoisted(
  () => [] as Array<(batch: { kind: string; content: string }[], s: { id: string }) => void>,
);
vi.mock('../../delivery.js', () => ({
  registerDeliveryBatchPreview: vi.fn((fn: (typeof previewHooks)[number]) => void previewHooks.push(fn)),
}));

import { slackCall } from '../../channels/slack-lib.js';
import { log } from '../../log.js';
import { pauseTypingRefreshAfterDelivery } from '../typing/index.js';
import './wake-status.js';
import {
  clearStatusAfterStream,
  clearWakeStatus,
  clearWorkingStatus,
  loadingLines,
  pickPlayful,
  PLAYFUL_LINES,
  resetStatusState,
  setWorkingStatus,
  startWakeStatus,
  statusText,
  STATUS_REFRESH_MS,
  STATUS_STALE_MS,
  WAKE_DELAY_MS,
  WAKE_MAX_MS,
} from './status.js';

const call = vi.mocked(slackCall);
const pause = vi.mocked(pauseTypingRefreshAfterDelivery);
const target = { token: 'xoxb-test', channel: 'C1', threadTs: '100.1' };
const statuses = () => call.mock.calls.map((c) => (c[2] as { status: string }).status);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetStatusState();
  call.mockResolvedValue({ ok: true });
});
afterEach(() => {
  resetStatusState();
  vi.useRealTimers();
});

describe('working status', () => {
  it('sets "is working: <doing>" and pauses the typing refresher', async () => {
    setWorkingStatus('s1', 't1', target, 'Reading files');
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledWith(
      'xoxb-test',
      'assistant.threads.setStatus',
      {
        channel_id: 'C1',
        thread_ts: '100.1',
        status: 'is working: Reading files',
        loading_messages: expect.arrayContaining(['Reading files']),
      },
      'status',
    );
    expect(pause).toHaveBeenCalledWith('s1');
  });

  it('rotates the real step first, then playful lines', () => {
    expect(loadingLines('is working: Count lines', true, ['a', 'b', 'c', 'd'])).toEqual(['Count lines', 'a', 'b', 'c']);
    expect(loadingLines('is working', false, ['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('picks distinct playful lines from the list', () => {
    const picks = pickPlayful(5, () => 0);
    expect(new Set(picks).size).toBe(5);
    for (const p of picks) expect(PLAYFUL_LINES).toContain(p);
    expect(PLAYFUL_LINES.every((l) => l.length <= 50 && !l.includes('\u2014') && !l.startsWith('is '))).toBe(true);
  });

  it('uses a bare "is working" when doing is empty and trims long text', () => {
    expect(statusText(null)).toBe('is working');
    expect(statusText('  ')).toBe('is working');
    const long = statusText('x'.repeat(300));
    expect(long.length).toBe('is working: '.length + 100);
    expect(long.endsWith('...')).toBe(true);
  });

  it('the same doing again does not call Slack until the refresh tick', async () => {
    setWorkingStatus('s1', 't1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(0);
    setWorkingStatus('s1', 't1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS - 1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('a changed doing sends the new text at once', async () => {
    setWorkingStatus('s1', 't1', target, 'Reading');
    setWorkingStatus('s1', 't1', target, 'Writing');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['is working: Reading', 'is working: Writing']);
  });

  it('the refresh tick re-sends the status and re-pauses typing', async () => {
    setWorkingStatus('s1', 't1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
    expect(statuses()).toEqual(['is working: Reading', 'is working: Reading']);
    expect(pause).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('clearing stops the timer and sends an empty status', async () => {
    setWorkingStatus('s1', 't1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(0);
    clearWorkingStatus('s1', 't1');
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 3);
    expect(statuses()).toEqual(['is working: Reading', '']);
  });

  it('clearing for a different turn leaves the status alone', async () => {
    setWorkingStatus('s1', 't2', target, 'Reading');
    clearWorkingStatus('s1', 't1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['is working: Reading']);
  });

  it('a Slack error is logged and never thrown', async () => {
    call.mockRejectedValue(new Error('boom'));
    expect(() => setWorkingStatus('s1', 't1', target, 'Reading')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('wake status', () => {
  const lines = () => call.mock.calls.map((c) => (c[2] as { loading_messages?: string[] }).loading_messages);

  it('shows playful lines after the delay, not before', async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS - 1);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses()).toEqual(['is working']);
    for (const l of lines()[0]!) expect(PLAYFUL_LINES).toContain(l);
    expect(pause).toHaveBeenCalledWith('s1');
  });

  it("the turn's first progress takes over with the same playful picks", async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS);
    const first = lines()[0]!;
    setWorkingStatus('s1', 'turn1', target, 'Count lines');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['is working', 'is working: Count lines']);
    expect(lines()[1]).toEqual(['Count lines', ...first.slice(0, 3)]);
  });

  it("does not replace a status a turn already owns, but puts it back after the new message's typing tick", async () => {
    setWorkingStatus('s1', 'turn1', target, 'Reading');
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS);
    expect(statuses()).toEqual(['is working: Reading', 'is working: Reading']);
  });

  it('a later message extends the wake status cap', async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_MAX_MS - 1000);
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS + STATUS_REFRESH_MS * 2);
    expect(statuses().at(-1)).toBe('is working');
    await vi.advanceTimersByTimeAsync(WAKE_MAX_MS);
    expect(statuses().at(-1)).toBe('');
  });

  it('a card-only turn: any non-progress outbound row clears the wake status', async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS);
    previewHooks[0]!([{ kind: 'system', content: JSON.stringify({ action: 'post_card' }) }], { id: 's1' });
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 3);
    expect(statuses()).toEqual(['is working', '']);
  });

  it('a reaction-only or chat row clears it; progress and stream rows do not', async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS);
    previewHooks[0]!(
      [
        { kind: 'system', content: JSON.stringify({ action: 'progress' }) },
        { kind: 'system', content: JSON.stringify({ action: 'stream_append' }) },
        { kind: 'system', content: 'not json' },
      ].slice(0, 2),
      { id: 's1' },
    );
    expect(statuses()).toEqual(['is working']);
    previewHooks[0]!([{ kind: 'system', content: JSON.stringify({ action: 'add_reaction' }) }], { id: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['is working', '']);
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS);
    previewHooks[0]!([{ kind: 'chat', content: '{}' }], { id: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses().at(-1)).toBe('');
  });

  it('a turn status with no new progress row for 2 minutes stops refreshing and is cleared', async () => {
    setWorkingStatus('s1', 'turn1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(STATUS_STALE_MS + STATUS_REFRESH_MS);
    expect(statuses().at(-1)).toBe('');
    const n = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 5);
    expect(call.mock.calls.length).toBe(n);
  });

  it('a progress row with the same text keeps the turn status alive past 2 minutes', async () => {
    setWorkingStatus('s1', 'turn1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(STATUS_STALE_MS - 1000);
    setWorkingStatus('s1', 'turn1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 2);
    expect(statuses().at(-1)).toBe('is working: Reading');
  });

  it('after a stream ends the status is cleared on the session chain, unless a turn owns it', async () => {
    clearStatusAfterStream('s1', target);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['']);
    call.mockClear();
    setWorkingStatus('s1', 'turn1', target, 'Reading');
    await vi.advanceTimersByTimeAsync(0);
    clearStatusAfterStream('s1', target);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['is working: Reading']);
  });

  it('a reply clears the wake status and stops its refresh', async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS);
    clearWakeStatus('s1');
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 3);
    expect(statuses()).toEqual(['is working', '']);
  });

  it('a reply before the delay cancels it', async () => {
    startWakeStatus('s1', target);
    clearWakeStatus('s1');
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS * 2);
    expect(call).not.toHaveBeenCalled();
  });

  it("a reply never clears a turn's own status", async () => {
    setWorkingStatus('s1', 'turn1', target, 'Reading');
    clearWakeStatus('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses()).toEqual(['is working: Reading']);
  });

  it('a wake status with no plan behind it gives up after the cap', async () => {
    startWakeStatus('s1', target);
    await vi.advanceTimersByTimeAsync(WAKE_DELAY_MS + WAKE_MAX_MS + STATUS_REFRESH_MS);
    expect(statuses().at(-1)).toBe('');
    const n = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 3);
    expect(call.mock.calls.length).toBe(n);
  });
});
