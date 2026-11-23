import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import './migrations.js';
import {
  closePlan,
  getPlan,
  getStream,
  listStale,
  upsertPlan,
  upsertStream,
  type PlanRow,
  type StreamRow,
} from './progress.js';

const plan = (over: Partial<PlanRow> = {}): PlanRow => ({
  turnId: 'turn-1',
  sessionId: 'sess-1',
  agentGroupId: 'ag-1',
  instance: 'slack',
  channelId: 'C1',
  threadTs: '1700000000.000100',
  messageTs: null,
  stateJson: '{"rows":[]}',
  lastDrawnAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  closed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const stream = (over: Partial<StreamRow> = {}): StreamRow => ({
  streamId: 'stream-1',
  sessionId: 'sess-1',
  instance: 'slack',
  channelId: 'C1',
  threadTs: '1700000000.000100',
  streamTs: null,
  status: 'open',
  sentText: '',
  held: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('progress storage', () => {
  it('upsert and get round trip', async () => {
    expect(await getPlan('turn-1')).toBeNull();
    expect(await getStream('stream-1')).toBeNull();

    await upsertPlan(plan());
    await upsertStream(stream());
    expect(await getPlan('turn-1')).toEqual(plan());
    expect(await getStream('stream-1')).toEqual(stream());

    await upsertPlan(plan({ messageTs: '1700000001.000200', closed: true, createdAt: 'ignored' }));
    await upsertStream(stream({ streamTs: '1700000002.000300', status: 'stopped', sentText: 'hi', held: true }));
    expect(await getPlan('turn-1')).toMatchObject({ messageTs: '1700000001.000200', closed: true });
    expect((await getPlan('turn-1'))!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(await getStream('stream-1')).toMatchObject({
      streamTs: '1700000002.000300',
      status: 'stopped',
      sentText: 'hi',
      held: true,
    });
  });

  it('closePlan', async () => {
    await upsertPlan(plan());
    await closePlan('turn-1');
    expect((await getPlan('turn-1'))!.closed).toBe(true);
  });

  it('listStale returns only open, older rows', async () => {
    const old = '2026-01-01T00:00:00.000Z';
    const fresh = '2026-01-01T01:00:00.000Z';
    await upsertPlan(plan({ turnId: 'old-open', updatedAt: old }));
    await upsertPlan(plan({ turnId: 'old-closed', updatedAt: old, closed: true }));
    await upsertPlan(plan({ turnId: 'fresh-open', updatedAt: fresh }));
    await upsertStream(stream({ streamId: 'old-open', updatedAt: old }));
    await upsertStream(stream({ streamId: 'old-stopped', updatedAt: old, status: 'stopped' }));
    await upsertStream(stream({ streamId: 'old-failed', updatedAt: old, status: 'failed' }));
    await upsertStream(stream({ streamId: 'fresh-open', updatedAt: fresh }));

    const stale = await listStale('2026-01-01T00:30:00.000Z');
    expect(stale.plans.map((p) => p.turnId)).toEqual(['old-open']);
    expect(stale.streams.map((s) => s.streamId)).toEqual(['old-open']);
  });
});
