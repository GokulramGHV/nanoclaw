import type { ActionEvent, Adapter } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardEvent } from 'slack-ui-kit';

vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const fake = vi.hoisted(() => ({ calls: [] as Array<{ method: string; args: any }>, hasToken: true }));
function makeClient() {
  const rec =
    (method: string, result: unknown = { ok: true }) =>
    async (args: unknown) => {
      fake.calls.push({ method, args });
      return result;
    };
  return {
    chat: {
      postMessage: rec('chat.postMessage', { ok: true, ts: '1700000000.000100' }),
      update: rec('chat.update'),
      delete: rec('chat.delete'),
      postEphemeral: rec('chat.postEphemeral'),
    },
    views: { open: rec('views.open') },
  };
}
vi.mock('./slack-client.js', () => ({
  slackClientForInstance: () => (fake.hasToken ? makeClient() : undefined),
  slackClientForToken: () => makeClient(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { log } from '../../log.js';
import './db/migrations.js';
import { handleKitAction, locateMessage, NO_LONGER_ACTIVE } from './clicks.js';
import { kit, registerCardEventHandler } from './kit.js';

const SOURCE = `root = Root([acts])
$decision = ""
acts = Actions([go])
go = Button("Go", Action([@Set($decision, "go")]), "primary")`;

const TS = '1700000000.000100';
const adapter = {} as Adapter;

const press = (over: Record<string, unknown> = {}, actionId = 'go', user = 'U1') =>
  ({
    actionId,
    user: { userId: user },
    raw: {
      type: 'block_actions',
      user: { id: user },
      channel: { id: 'C1' },
      container: { channel_id: 'C1', message_ts: TS },
      message: { ts: TS },
      trigger_id: 't1',
      actions: [{ type: 'button', action_id: actionId, text: { type: 'plain_text', text: 'Go' } }],
      ...over,
    },
  }) as unknown as ActionEvent;

const events: CardEvent[] = [];
let failFirst = false;

async function postCard(instance = 'slack') {
  const client = makeClient();
  await kit.postCard(client, { channel: 'C1' }, SOURCE, {
    owner: 'U1',
    trusted: true,
    placeholder: false,
    meta: { kind: 'card', cardId: 'card-1', template: 'demo', agentGroupId: 'ag-1', sessionId: 's-1', instance },
  });
  fake.calls.length = 0;
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.hasToken = true;
  events.length = 0;
  failFirst = false;
  registerCardEventHandler('card', async (e) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('write failed');
    }
    events.push(e);
  });
});

afterEach(async () => {
  await closeDb();
});

describe('locateMessage', () => {
  it('reads container first, then channel and message', () => {
    expect(locateMessage({ container: { channel_id: 'C1', message_ts: '1.1' } })).toEqual({ channel: 'C1', ts: '1.1' });
    expect(locateMessage({ channel: { id: 'C2' }, message: { ts: '2.2' } })).toEqual({ channel: 'C2', ts: '2.2' });
    expect(locateMessage({ channel: { id: 'C2' } })).toBeUndefined();
    expect(locateMessage('x')).toBeUndefined();
  });
});

describe('handleKitAction', () => {
  it('answers an old ncu: press privately and claims it', async () => {
    expect(await handleKitAction(press({}, 'ncu:card-1:go'), adapter, 'slack')).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      method: 'chat.postEphemeral',
      args: { channel: 'C1', user: 'U1', text: NO_LONGER_ACTIVE },
    });
  });

  it('falls through when no card is stored for the message', async () => {
    expect(await handleKitAction(press(), adapter, 'slack')).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('falls through when the press carries no message location', async () => {
    expect(
      await handleKitAction(press({ container: undefined, channel: undefined, message: undefined }), adapter, 'slack'),
    ).toBe(false);
  });

  it('falls through when the card belongs to another Slack app instance', async () => {
    await postCard('other');
    expect(await handleKitAction(press(), adapter, 'slack')).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('hands a kit card press to the kit: redraws, locks and sends one event', async () => {
    await postCard();
    expect(await handleKitAction(press(), adapter, 'slack')).toBe(true);
    expect(fake.calls.map((c) => c.method)).toContain('chat.update');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'action',
      user: 'U1',
      control: { id: 'go', kind: 'button' },
      state: { $decision: 'go' },
      meta: { cardId: 'card-1', kind: 'card' },
    });
    expect((await kit.getCard('C1', TS))?.locked?.by).toBe('U1');
  });

  it('refuses a press from someone who is not the owner, privately, with no event', async () => {
    await postCard();
    expect(await handleKitAction(press({}, 'go', 'U2'), adapter, 'slack')).toBe(true);
    expect(fake.calls.map((c) => c.method)).toContain('chat.postEphemeral');
    expect(events).toHaveLength(0);
  });

  it('retries the event once when its handler fails, and does not throw', async () => {
    await postCard();
    failFirst = true;
    await expect(handleKitAction(press(), adapter, 'slack')).resolves.toBe(true);
    expect(events).toHaveLength(1);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining('retrying once'), expect.anything());
  });

  it('claims the press without throwing when there is no bot token', async () => {
    await postCard();
    fake.hasToken = false;
    await expect(handleKitAction(press(), adapter, 'slack')).resolves.toBe(true);
    expect(events).toHaveLength(0);
  });
});
