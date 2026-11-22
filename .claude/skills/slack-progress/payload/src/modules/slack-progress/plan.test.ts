import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  botTokenKeyForInstance: (i: string) => (i === 'slack' ? 'SLACK_BOT_TOKEN' : 'SLACK_BOT_TOKEN_X'),
}));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));
vi.mock('../../delivery.js', () => ({ registerDeliveryAction: vi.fn() }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./settings.js', () => ({ isEnabled: vi.fn() }));
vi.mock('./db/progress.js', () => {
  const plans = new Map<string, any>();
  return {
    __plans: plans,
    getPlan: vi.fn(async (id: string) => plans.get(id) ?? null),
    upsertPlan: vi.fn(async (p: any) => void plans.set(p.turnId, { ...p })),
    closePlan: vi.fn(async (id: string) => {
      const p = plans.get(id);
      if (p) p.closed = true;
    }),
  };
});

import { slackCall } from '../../channels/slack-lib.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import * as progressDb from './db/progress.js';
import { handleProgress, parseProgressRow, resetPlanState } from './plan.js';
import { rateLimit } from './rate-limit.js';
import { isEnabled } from './settings.js';

const plans = (progressDb as unknown as { __plans: Map<string, any> }).__plans;
const call = vi.mocked(slackCall);
const session = { id: 's1', agent_group_id: 'ag1', messaging_group_id: 'mg1', thread_id: 'slack:C1:100.1' } as any;

const content = (over: Record<string, unknown> = {}) => ({
  action: 'progress',
  turnId: 'turn1',
  platformId: 'slack:C1',
  threadId: 'slack:C1:100.1',
  todos: [{ title: 'Step', status: 'in_progress' }],
  doing: 'Working',
  startedAt: '2026-01-01T00:00:00.000Z',
  elapsedMs: 1000,
  outcome: 'working',
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.clearAllMocks();
  plans.clear();
  resetPlanState();
  vi.mocked(isEnabled).mockResolvedValue(true);
  vi.mocked(getMessagingGroup).mockResolvedValue({
    channel_type: 'slack',
    platform_id: 'slack:C1',
    instance: null,
  } as any);
  vi.mocked(envValue).mockReturnValue('xoxb-test');
  call.mockResolvedValue({ ok: true, ts: '200.1' });
});
afterEach(() => vi.useRealTimers());

describe('progress action', () => {
  it('registers as an unguarded delivery action', () => {
    // The registration ran at import; clearAllMocks wiped the record, so re-import.
    vi.resetModules();
    return import('./plan.js').then(() => {
      expect(vi.mocked(registerDeliveryAction).mock.calls[0][0]).toBe('progress');
    });
  });

  it('first row posts with chat.postMessage into the thread and stores message_ts', async () => {
    await handleProgress(content(), session);
    expect(call).toHaveBeenCalledTimes(1);
    const [token, method, body] = call.mock.calls[0];
    expect(token).toBe('xoxb-test');
    expect(method).toBe('chat.postMessage');
    expect(body).toMatchObject({ channel: 'C1', thread_ts: '100.1' });
    expect(plans.get('turn1').messageTs).toBe('200.1');
  });

  it('later rows chat.update at most once per 2000 ms with the latest state', async () => {
    await handleProgress(content(), session);
    call.mockClear();
    await handleProgress(content({ doing: 'B' }), session);
    await handleProgress(content({ doing: 'C' }), session);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBe('chat.update');
    expect(call.mock.calls[0][2]).toMatchObject({ channel: 'C1', ts: '200.1' });
    expect(JSON.stringify(call.mock.calls[0][2])).toContain('C');
    expect(JSON.stringify(call.mock.calls[0][2])).not.toContain('"B"');
  });

  it('outcome done draws the summary at once and closes the plan', async () => {
    await handleProgress(content(), session);
    call.mockClear();
    await handleProgress(content({ doing: 'B' }), session);
    await handleProgress(content({ outcome: 'done', elapsedMs: 42000 }), session);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBe('chat.update');
    expect((call.mock.calls[0][2] as { text: string }).text).toContain('Done in 42s');
    expect(plans.get('turn1').closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a timer draw in flight when the summary arrives cannot overwrite it or reopen the row', async () => {
    await handleProgress(content(), session);
    call.mockClear();
    await handleProgress(content({ doing: 'B' }), session); // schedules a timer
    let release!: () => void;
    call.mockImplementationOnce(() => new Promise((res) => (release = () => res({ ok: true, ts: '200.1' }))));
    await vi.advanceTimersByTimeAsync(3000); // the timer draw fires, its send is pending
    expect(call).toHaveBeenCalledTimes(1);
    const done = handleProgress(content({ outcome: 'done', elapsedMs: 42000 }), session);
    await vi.advanceTimersByTimeAsync(10);
    release();
    await done;
    await vi.advanceTimersByTimeAsync(3000);
    const last = call.mock.calls[call.mock.calls.length - 1];
    expect((last[2] as { text: string }).text).toContain('Done in 42s');
    expect(plans.get('turn1').closed).toBe(true);
  });

  it('a closePlan failure is logged', async () => {
    await handleProgress(content(), session);
    vi.mocked(progressDb.closePlan).mockRejectedValueOnce(new Error('db down'));
    await handleProgress(content({ outcome: 'done' }), session);
    expect(log.warn).toHaveBeenCalledWith('slack-progress: could not close plan', expect.anything());
  });

  it('invalid_blocks on a pending card retries with pendingOk false and remembers it', async () => {
    const pending = {
      todos: [
        { title: 'Later', status: 'pending' },
        { title: 'Now', status: 'in_progress' },
      ],
    };
    const err = Object.assign(new Error('slack chat.postMessage failed: invalid_blocks'), { name: 'SlackApiError' });
    call.mockRejectedValueOnce(err).mockResolvedValue({ ok: true, ts: '200.1' });
    await handleProgress(content(pending), session);
    expect(call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(call.mock.calls[0][2])).toContain('"pending"');
    expect(JSON.stringify(call.mock.calls[1][2])).not.toContain('"status":"pending"');
    // Remembered: a later turn goes straight to the fallback shape.
    call.mockClear();
    await handleProgress(content({ ...pending, turnId: 'turn2' }), session);
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(call.mock.calls[0][2])).not.toContain('"status":"pending"');
  });

  it('disabled group: no Slack call', async () => {
    vi.mocked(isEnabled).mockResolvedValue(false);
    await handleProgress(content(), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('non-slack messaging group: no Slack call', async () => {
    vi.mocked(getMessagingGroup).mockResolvedValue({
      channel_type: 'telegram',
      platform_id: 'telegram:1',
      instance: null,
    } as any);
    await handleProgress(content(), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('slackCall failure is logged, never thrown', async () => {
    call.mockRejectedValue(new Error('boom'));
    await expect(handleProgress(content(), session)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('a malformed row is logged and dropped', async () => {
    await handleProgress({ action: 'progress' }, session);
    expect(call).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('a row for another chat posts nothing', async () => {
    await handleProgress(content({ platformId: 'slack:C2', threadId: 'slack:C2:5.5' }), session);
    expect(call).not.toHaveBeenCalled();
    expect(plans.size).toBe(0);
  });

  it('a channel listed in SLACK_A2A_ROOMS gets no plan', async () => {
    vi.mocked(envValue).mockImplementation((k: string) => (k === 'SLACK_A2A_ROOMS' ? 'C9, slack:C1' : 'xoxb-test'));
    await handleProgress(content(), session);
    expect(call).not.toHaveBeenCalled();
    expect(plans.size).toBe(0);
  });

  it('one malformed todo is skipped and the rest of the row is kept', () => {
    const row = parseProgressRow(
      content({
        todos: [{ status: 'pending' }, null, { title: 'Odd', status: 'weird' }, { title: 'Ok', status: 'pending' }],
      }),
    );
    expect(row?.todos).toEqual([{ title: 'Ok', status: 'pending' }]);
  });

  describe('rate limits', () => {
    const limited = () => Object.assign(new Error('slack chat.update failed: ratelimited'), { name: 'SlackApiError' });

    it('a rate-limited summary update is retried and the plan is closed once it succeeds', async () => {
      await handleProgress(content(), session);
      call.mockClear();
      call.mockRejectedValueOnce(limited()).mockResolvedValue({ ok: true });
      const done = handleProgress(content({ outcome: 'done' }), session);
      await vi.advanceTimersByTimeAsync(rateLimit.delaysMs[0]);
      await done;
      expect(call.mock.calls.map((c) => c[1])).toEqual(['chat.update', 'chat.update']);
      expect(plans.get('turn1').closed).toBe(true);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
