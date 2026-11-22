import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  botTokenKeyForInstance: (i: string) => (i === 'slack' ? 'SLACK_BOT_TOKEN' : 'SLACK_BOT_TOKEN_X'),
}));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./settings.js', () => ({ isEnabled: vi.fn() }));
vi.mock('./streams.js', () => ({ endWithNote: vi.fn(async () => undefined) }));
vi.mock('./db/progress.js', () => ({
  listStale: vi.fn(),
  closePlan: vi.fn(async () => undefined),
  upsertStream: vi.fn(async () => undefined),
}));

import { slackCall } from '../../channels/slack-lib.js';
import { isContainerRunning } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import * as progressDb from './db/progress.js';
import { isEnabled } from './settings.js';
import { endWithNote } from './streams.js';
import { STALE_MS, sweepOnce } from './sweep.js';

const NOW = Date.parse('2026-01-01T01:00:00Z');
const old = new Date(NOW - STALE_MS - 1000).toISOString();

const planRow = (over: Record<string, unknown> = {}) => ({
  turnId: 't1',
  sessionId: 's1',
  agentGroupId: 'ag1',
  instance: 'slack',
  channelId: 'C1',
  threadTs: '100.1',
  messageTs: '200.1',
  stateJson: JSON.stringify({
    action: 'progress',
    turnId: 't1',
    platformId: 'slack:C1',
    threadId: 'slack:C1:100.1',
    todos: [{ title: 'Step one', status: 'in_progress' }],
    doing: 'Working',
    startedAt: new Date(NOW - STALE_MS - 61000).toISOString(),
    elapsedMs: 1000,
    outcome: 'working',
  }),
  lastDrawnAt: old,
  updatedAt: old,
  closed: false,
  createdAt: old,
  ...over,
});
const streamRow = (over: Record<string, unknown> = {}) => ({
  streamId: 'st1',
  sessionId: 's1',
  instance: 'slack',
  channelId: 'C1',
  threadTs: '100.1',
  streamTs: '300.1',
  status: 'open',
  sentText: 'Hi',
  updatedAt: old,
  createdAt: old,
  ...over,
});
const stale = (plans: any[], streams: any[]) => vi.mocked(progressDb.listStale).mockResolvedValue({ plans, streams });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isEnabled).mockResolvedValue(true);
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(getSession).mockResolvedValue({ id: 's1', agent_group_id: 'ag1' } as any);
  vi.mocked(envValue).mockReturnValue('xoxb-test');
  vi.mocked(slackCall).mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

describe('sweepOnce', () => {
  it('plan silent 120000 ms with no running container is redrawn as "Stopped after Ns" with the in-progress card error and closed', async () => {
    stale([planRow()], []);
    await sweepOnce(NOW);
    const [, method, body] = vi.mocked(slackCall).mock.calls[0] as any;
    expect(method).toBe('chat.update');
    expect(body.channel).toBe('C1');
    expect(body.ts).toBe('200.1');
    expect(body.text).toMatch(/^Stopped after \d+s/);
    expect(JSON.stringify(body.blocks)).toContain('"status":"error"');
    expect(progressDb.closePlan).toHaveBeenCalledWith('t1');
  });

  it('plan silent but container running is left alone', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    stale([planRow()], [streamRow()]);
    await sweepOnce(NOW);
    expect(slackCall).not.toHaveBeenCalled();
    expect(endWithNote).not.toHaveBeenCalled();
    expect(progressDb.closePlan).not.toHaveBeenCalled();
    expect(progressDb.upsertStream).not.toHaveBeenCalled();
  });

  it('open stream silent 120000 ms with no container is stopped with "reply interrupted" and marked stopped', async () => {
    stale([], [streamRow()]);
    await sweepOnce(NOW);
    expect(endWithNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(endWithNote).mock.calls[0][1]).toMatch(/reply interrupted/i);
    expect(progressDb.upsertStream).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'st1', status: 'stopped' }));
  });

  it('makes no Slack calls for a group where the feature is off', async () => {
    vi.mocked(isEnabled).mockResolvedValue(false);
    stale([planRow()], [streamRow()]);
    await sweepOnce(NOW);
    expect(slackCall).not.toHaveBeenCalled();
    expect(endWithNote).not.toHaveBeenCalled();
    expect(progressDb.closePlan).toHaveBeenCalledWith('t1');
    expect(progressDb.upsertStream).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
  });

  it('sweep errors are logged, never thrown', async () => {
    vi.mocked(slackCall).mockRejectedValue(new Error('boom'));
    stale([planRow(), planRow({ turnId: 't2' })], [streamRow()]);
    await expect(sweepOnce(NOW)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    vi.mocked(progressDb.listStale).mockRejectedValue(new Error('db down'));
    await expect(sweepOnce(NOW)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('closes a plan and a stream even when every Slack call and the state parse fail', async () => {
    vi.mocked(slackCall).mockRejectedValue(new Error('boom'));
    stale([planRow(), planRow({ turnId: 't2', stateJson: '{bad' })], [streamRow()]);
    await sweepOnce(NOW);
    expect(progressDb.closePlan).toHaveBeenCalledWith('t1');
    expect(progressDb.closePlan).toHaveBeenCalledWith('t2');
    expect(progressDb.upsertStream).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
  });

  it('marks a stream stopped even when the session lookup throws', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('db'));
    stale([], [streamRow()]);
    await sweepOnce(NOW);
    expect(progressDb.upsertStream).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
  });
});
