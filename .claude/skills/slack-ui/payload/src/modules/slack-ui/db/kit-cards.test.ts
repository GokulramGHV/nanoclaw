import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardRecord } from 'slack-ui-kit';

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import './migrations.js';
import { getCardById, KitCardStore } from './kit-cards.js';

const record = (over: Partial<CardRecord> = {}): CardRecord => ({
  channel: 'C1',
  ts: '1700000000.000100',
  owner: 'U1',
  access: {},
  trusted: true,
  kind: 'openui',
  state: {},
  text: 't',
  blocks: [],
  controls: {},
  forms: {},
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  meta: {
    kind: 'card',
    cardId: 'card-1',
    template: 'demo',
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    instance: 'slack',
  },
  ...over,
});

const store = new KitCardStore();

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('KitCardStore', () => {
  it('inserts with a null expected version and reads the card back', async () => {
    expect(await store.put(record(), null)).toBe(true);
    expect(await store.get('C1', '1700000000.000100')).toEqual(record());
    expect(await store.get('C1', 'other')).toBeUndefined();
  });

  it('copies host columns from meta, with ISO timestamps', async () => {
    await store.put(record(), null);
    const row = await getDb().get<Record<string, unknown>>('SELECT * FROM ui_kit_cards');
    expect(row).toMatchObject({
      channel_id: 'C1',
      message_ts: '1700000000.000100',
      card_id: 'card-1',
      agent_group_id: 'ag-1',
      session_id: 'sess-1',
      instance: 'slack',
      kind: 'card',
      template_name: 'demo',
      version: 1,
    });
    expect(String(row!.created_at)).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(String(row!.updated_at)).toISOString()).toBe(row!.updated_at);
  });

  it('stores an ask card with kind ask and a card without a card id', async () => {
    await store.put(record({ meta: { kind: 'ask', sessionId: 's', agentGroupId: 'a', instance: 'slack' } }), null);
    const row = await getDb().get<Record<string, unknown>>('SELECT kind, card_id, template_name FROM ui_kit_cards');
    expect(row).toEqual({ kind: 'ask', card_id: null, template_name: null });
  });

  it('returns false for an insert on an existing key and keeps the first card', async () => {
    await store.put(record(), null);
    expect(await store.put(record({ owner: 'U2', meta: { kind: 'card', cardId: 'card-2' } }), null)).toBe(false);
    expect((await store.get('C1', '1700000000.000100'))?.owner).toBe('U1');
  });

  it('returns false for an insert whose card id is already used', async () => {
    await store.put(record(), null);
    expect(await store.put(record({ ts: '1700000000.000200' }), null)).toBe(false);
    expect(await store.get('C1', '1700000000.000200')).toBeUndefined();
  });

  it('updates only while the stored version equals the expected one', async () => {
    await store.put(record(), null);
    expect(await store.put(record({ version: 2, owner: 'U2' }), 1)).toBe(true);
    expect((await store.get('C1', '1700000000.000100'))?.version).toBe(2);
    expect((await getDb().get<{ version: number }>('SELECT version FROM ui_kit_cards'))?.version).toBe(2);
    // A second writer that read version 1 loses.
    expect(await store.put(record({ version: 2, owner: 'U3' }), 1)).toBe(false);
    expect((await store.get('C1', '1700000000.000100'))?.owner).toBe('U2');
  });

  it('returns false when updating a card that does not exist', async () => {
    expect(await store.put(record({ version: 2 }), 1)).toBe(false);
  });

  it('finds a card by its container card id', async () => {
    await store.put(record(), null);
    expect(await getCardById('card-1')).toEqual(record());
    expect(await getCardById('nope')).toBeUndefined();
  });
});
