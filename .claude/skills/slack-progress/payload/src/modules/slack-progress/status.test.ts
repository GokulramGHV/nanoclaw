import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({ slackCall: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../typing/index.js', () => ({ pauseTypingRefreshAfterDelivery: vi.fn() }));

import { slackCall } from '../../channels/slack-lib.js';
import { log } from '../../log.js';
import { pauseTypingRefreshAfterDelivery } from '../typing/index.js';
import { clearWorkingStatus, resetStatusState, setWorkingStatus, statusText, STATUS_REFRESH_MS } from './status.js';

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
      { channel_id: 'C1', thread_ts: '100.1', status: 'is working: Reading files' },
      'status',
    );
    expect(pause).toHaveBeenCalledWith('s1');
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
