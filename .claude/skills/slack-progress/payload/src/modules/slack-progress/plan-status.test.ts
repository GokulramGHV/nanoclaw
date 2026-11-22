import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  botTokenKeyForInstance: (i: string) => (i === 'slack' ? 'SLACK_BOT_TOKEN' : 'SLACK_BOT_TOKEN_X'),
}));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));
vi.mock('../../delivery.js', () => ({ registerDeliveryAction: vi.fn() }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../typing/index.js', () => ({ pauseTypingRefreshAfterDelivery: vi.fn() }));
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
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { pauseTypingRefreshAfterDelivery } from '../typing/index.js';
import * as progressDb from './db/progress.js';
import { handleProgress, resetPlanState } from './plan.js';
import { isEnabled } from './settings.js';
import { STATUS_REFRESH_MS } from './status.js';

const plans = (progressDb as unknown as { __plans: Map<string, any> }).__plans;
const call = vi.mocked(slackCall);
const session = { id: 's1', agent_group_id: 'ag1', messaging_group_id: 'mg1', thread_id: 'slack:C1:100.1' } as any;
const statusCalls = () => call.mock.calls.filter((c) => c[1] === 'assistant.threads.setStatus');
const statuses = () => statusCalls().map((c) => (c[2] as { status: string }).status);

const content = (over: Record<string, unknown> = {}) => ({
  action: 'progress',
  turnId: 'turn1',
  platformId: 'slack:C1',
  threadId: 'slack:C1:100.1',
  todos: [{ title: 'Step', status: 'in_progress' }],
  doing: 'Reading files',
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
afterEach(() => {
  resetPlanState();
  vi.useRealTimers();
});

describe('status line from progress rows', () => {
  it('a working row sets the status and pauses typing', async () => {
    await handleProgress(content(), session);
    expect(statuses()).toEqual(['is working: Reading files']);
    expect(pauseTypingRefreshAfterDelivery).toHaveBeenCalledWith('s1');
  });

  it('the same doing again does not call Slack until the refresh tick, which re-sends and re-pauses', async () => {
    await handleProgress(content(), session);
    await handleProgress(content(), session);
    expect(statusCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
    expect(statusCalls()).toHaveLength(2);
    expect(pauseTypingRefreshAfterDelivery).toHaveBeenCalledTimes(2);
  });

  it('a done row stops the timer and clears the status', async () => {
    await handleProgress(content(), session);
    await handleProgress(content({ outcome: 'done' }), session);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS * 3);
    expect(statuses()).toEqual(['is working: Reading files', '']);
  });

  it('an error row clears the status too', async () => {
    await handleProgress(content(), session);
    await handleProgress(content({ outcome: 'error' }), session);
    expect(statuses()).toEqual(['is working: Reading files', '']);
  });

  it('no thread means no status call', async () => {
    await handleProgress(content({ threadId: null }), { ...session, thread_id: null });
    expect(statusCalls()).toHaveLength(0);
    expect(call).toHaveBeenCalled();
  });

  it('a disabled group makes no Slack call at all', async () => {
    vi.mocked(isEnabled).mockResolvedValue(false);
    await handleProgress(content(), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('a channel listed in SLACK_A2A_ROOMS gets no status', async () => {
    vi.mocked(envValue).mockImplementation((k: string) => (k === 'SLACK_A2A_ROOMS' ? 'slack:C1' : 'xoxb-test'));
    await handleProgress(content(), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('a row for another chat gets no status', async () => {
    await handleProgress(content({ platformId: 'slack:C2', threadId: 'slack:C2:5.5' }), session);
    expect(call).not.toHaveBeenCalled();
  });

  it('a Slack error on the status is logged and the plan still draws', async () => {
    call.mockImplementation(async (_t: string, method: string) => {
      if (method === 'assistant.threads.setStatus') throw new Error('status failed');
      return { ok: true, ts: '200.1' };
    });
    await handleProgress(content(), session);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.mock.calls.some((c) => c[1] === 'chat.postMessage')).toBe(true);
    expect(plans.get('turn1').messageTs).toBe('200.1');
    expect(log.warn).toHaveBeenCalled();
  });
});
