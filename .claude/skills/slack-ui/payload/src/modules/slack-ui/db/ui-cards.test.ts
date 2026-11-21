import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import type { CardTemplate } from '../template.js';
import './migrations.js';
import {
  deleteCard,
  getCard,
  insertCard,
  setMessageTs,
  tryLock,
  updateState,
  updateStateIfUnlocked,
  type NewCard,
} from './ui-cards.js';

const template: CardTemplate = {
  version: 1,
  name: 'demo-request',
  text: 'Hello {{who}}',
  data: {},
  controls: { approve: { who: 'owner', submit: true } },
  blocks: [],
};

const card = (over: Partial<NewCard> = {}): NewCard => ({
  id: 'card-1',
  agentGroupId: 'ag-1',
  sessionId: 'sess-1',
  instance: 'slack',
  channelId: 'C1',
  threadTs: '1700000000.000100',
  ownerUserId: 'U1',
  templateName: 'demo-request',
  template,
  data: { who: 'world' },
  state: { step: 1 },
  ...over,
});

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('ui_cards storage', () => {
  it('round-trips an inserted card', async () => {
    await insertCard(card());
    const got = await getCard('card-1');
    expect(got).toMatchObject({
      id: 'card-1',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      instance: 'slack',
      channelId: 'C1',
      threadTs: '1700000000.000100',
      messageTs: null,
      ownerUserId: 'U1',
      templateName: 'demo-request',
      template,
      data: { who: 'world' },
      state: { step: 1 },
      locked: false,
      lockedBy: null,
      lockedAt: null,
    });
    expect(Date.parse(got!.createdAt)).not.toBeNaN();
    expect(got!.updatedAt).toBe(got!.createdAt);
  });

  it('stores null thread and owner', async () => {
    await insertCard(card({ threadTs: null, ownerUserId: null }));
    expect(await getCard('card-1')).toMatchObject({ threadTs: null, ownerUserId: null });
  });

  it('returns undefined for an unknown card', async () => {
    expect(await getCard('nope')).toBeUndefined();
  });

  it('setMessageTs records the posted message ts', async () => {
    await insertCard(card());
    await setMessageTs('card-1', '1700000001.000200');
    expect((await getCard('card-1'))!.messageTs).toBe('1700000001.000200');
  });

  it('updateState replaces state and bumps updated_at', async () => {
    await insertCard(card());
    const before = await getCard('card-1');
    await new Promise((r) => setTimeout(r, 5));
    await updateState('card-1', { step: 2, picked: ['a'] });
    const after = await getCard('card-1');
    expect(after!.state).toEqual({ step: 2, picked: ['a'] });
    expect(after!.updatedAt > before!.updatedAt).toBe(true);
    expect(after!.createdAt).toBe(before!.createdAt);
  });

  it('tryLock succeeds once; the first user keeps the lock', async () => {
    await insertCard(card());
    expect(await tryLock('card-1', 'U2')).toBe(true);
    expect(await tryLock('card-1', 'U3')).toBe(false);
    const got = await getCard('card-1');
    expect(got).toMatchObject({ locked: true, lockedBy: 'U2' });
    expect(Date.parse(got!.lockedAt!)).not.toBeNaN();
  });

  it('tryLock on an unknown card returns false', async () => {
    expect(await tryLock('nope', 'U1')).toBe(false);
  });

  it('deleteCard removes the row', async () => {
    await insertCard(card());
    await deleteCard('card-1');
    expect(await getCard('card-1')).toBeUndefined();
  });
});

describe('updateStateIfUnlocked', () => {
  it('writes while unlocked and refuses once locked', async () => {
    await insertCard(card());
    expect(await updateStateIfUnlocked('card-1', { step: 2 })).toBe(true);
    expect((await getCard('card-1'))!.state).toEqual({ step: 2 });
    await tryLock('card-1', 'U1');
    expect(await updateStateIfUnlocked('card-1', { step: 3 })).toBe(false);
    expect((await getCard('card-1'))!.state).toEqual({ step: 2 });
  });
});
