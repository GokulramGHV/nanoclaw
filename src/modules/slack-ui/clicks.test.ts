import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  botTokenKeyForInstance: (i: string) => (i === 'slack' ? 'SLACK_BOT_TOKEN' : 'SLACK_BOT_TOKEN_X'),
}));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { ActionEvent, Adapter } from 'chat';

import { slackCall } from '../../channels/slack-lib.js';
import { getSession } from '../../db/sessions.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { envValue } from '../../env.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { handleCardAction } from './clicks.js';
import './db/migrations.js';
import { getCard, insertCard, updateState } from './db/ui-cards.js';
import type { CardTemplate } from './template.js';

const call = vi.mocked(slackCall);
const write = vi.mocked(writeSessionMessage);
const wake = vi.mocked(requestWake);

const template: CardTemplate = {
  version: 1,
  name: 'demo-request',
  text: 'Demo',
  data: {},
  controls: {
    pick: { who: 'owner' },
    ok: { who: 'owner' },
    create: { who: 'owner', submit: true },
    quiet: { who: 'owner', submit: true, notify: false },
    open: { who: 'anyone' },
  },
  blocks: [
    {
      type: 'actions',
      elements: [
        {
          type: 'checkboxes',
          action_id: 'pick',
          options: [
            { text: { type: 'plain_text', text: 'A' }, value: 'a' },
            { text: { type: 'plain_text', text: 'B' }, value: 'b' },
          ],
        },
        { type: 'button', action_id: 'ok', text: { type: 'plain_text', text: 'OK' } },
        { type: 'button', action_id: 'create', text: { type: 'plain_text', text: 'Create' } },
      ],
    },
  ],
};

const newCard = async (over: Record<string, unknown> = {}) => {
  await insertCard({
    id: 'c1',
    agentGroupId: 'ag-1',
    sessionId: 's-1',
    instance: 'slack',
    channelId: 'C1',
    threadTs: '1700000000.000100',
    ownerUserId: 'U1',
    templateName: 'demo-request',
    template,
    data: {},
    state: { pick: ['a', 'b'] },
    ...over,
  });
  await import('./db/ui-cards.js').then((m) => m.setMessageTs('c1', '1700000001.000200'));
};

function ev(actionId: string, opts: { user?: string; raw?: Record<string, unknown> } = {}): ActionEvent {
  const type = actionId.endsWith(':pick') ? 'checkboxes' : 'button';
  return {
    actionId,
    value: undefined,
    user: { userId: opts.user ?? 'U1', userName: 'alice', fullName: 'Alice A' },
    raw: {
      action_ts: '111.1',
      channel: { id: 'C1' },
      container: { thread_ts: '1700000000.000100' },
      actions: [{ action_id: actionId, type, value: 'v' }],
      ...opts.raw,
    },
  } as unknown as ActionEvent;
}

const adapter = {} as Adapter;
const methods = () => call.mock.calls.map((c) => c[1]);

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations(await initTestDb());
  vi.mocked(envValue).mockReturnValue('xoxb-test');
  call.mockResolvedValue({ ok: true });
  vi.mocked(getSession).mockResolvedValue({ id: 's-1' } as never);
  write.mockResolvedValue(undefined as never);
});

afterEach(async () => {
  await closeDb();
});

describe('handleCardAction', () => {
  it('returns false for a non-ncu id', async () => {
    expect(await handleCardAction(ev('ncq:x:y'), adapter, 'slack')).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('answers an unknown card with an ephemeral', async () => {
    expect(await handleCardAction(ev('ncu:nope:ok'), adapter, 'slack')).toBe(true);
    expect(call).toHaveBeenCalledWith(
      'xoxb-test',
      'chat.postEphemeral',
      expect.objectContaining({
        channel: 'C1',
        user: 'U1',
        text: 'This card is no longer active.',
        thread_ts: '1700000000.000100',
      }),
      expect.any(String),
    );
  });

  it('treats a card from another instance as inactive', async () => {
    await newCard({ instance: 'slack-other' });
    await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack');
    expect(call.mock.calls[0][2]).toMatchObject({ text: 'This card is no longer active.' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does nothing without a bot token', async () => {
    vi.mocked(envValue).mockReturnValue(undefined);
    expect(await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack')).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a non-owner, redraws stored state, no write', async () => {
    await newCard();
    const raw = {
      state: { values: { b1: { 'ncu:c1:pick': { type: 'checkboxes', selected_options: [] } } } },
    };
    expect(await handleCardAction(ev('ncu:c1:pick', { user: 'U2', raw }), adapter, 'slack')).toBe(true);
    expect(methods()).toEqual(['chat.postEphemeral', 'chat.update']);
    expect(call.mock.calls[0][2]).toMatchObject({ user: 'U2', text: 'Only <@U1> can do this.' });
    expect(call.mock.calls[1][2]).toMatchObject({ channel: 'C1', ts: '1700000001.000200' });
    expect((await getCard('c1'))!.state).toEqual({ pick: ['a', 'b'] });
    expect(write).not.toHaveBeenCalled();
  });

  it('stores a checkbox tick without notifying or redrawing', async () => {
    await newCard();
    const raw = {
      state: {
        values: {
          b1: { 'ncu:c1:pick': { type: 'checkboxes', selected_options: [{ value: 'a' }] } },
        },
      },
      actions: [{ action_id: 'ncu:c1:pick', type: 'checkboxes', selected_options: [{ value: 'a' }] }],
    };
    await handleCardAction(ev('ncu:c1:pick', { raw }), adapter, 'slack');
    expect((await getCard('c1'))!.state).toEqual({ pick: ['a'] });
    expect(write).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('ignores payload entries that belong to another card', async () => {
    await newCard();
    const raw = {
      state: {
        values: {
          b1: { 'ncu:other:pick': { type: 'checkboxes', selected_options: [{ value: 'z' }] } },
        },
      },
    };
    await handleCardAction(ev('ncu:c1:ok', { raw }), adapter, 'slack');
    expect((await getCard('c1'))!.state).toEqual({ pick: ['a', 'b'] });
    expect(JSON.parse(write.mock.calls[0][2].content).payload.state).toEqual({ pick: ['a', 'b'] });
  });

  it('sends one agent message for an allowed button', async () => {
    await newCard();
    await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack');
    expect(write).toHaveBeenCalledTimes(1);
    const [group, sess, msg] = write.mock.calls[0];
    expect([group, sess]).toEqual(['ag-1', 's-1']);
    expect(msg).toMatchObject({
      id: 'card-c1-111.1',
      kind: 'webhook',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: 'slack:C1:1700000000.000100',
    });
    expect(JSON.parse(msg.content)).toEqual({
      source: 'slack-ui',
      event: 'card_event',
      payload: {
        cardId: 'c1',
        template: 'demo-request',
        control: 'ok',
        value: 'v',
        user: { id: 'U1', name: 'alice' },
        state: { pick: ['a', 'b'] },
        locked: false,
      },
    });
    expect(wake).toHaveBeenCalledWith({ id: 's-1' }, 'interactive');
    expect(call).not.toHaveBeenCalled();
  });

  it('uses a null thread id for a card outside a thread', async () => {
    await newCard({ threadTs: null });
    await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack');
    expect(write.mock.calls[0][2].threadId).toBeNull();
  });

  it('submit locks, redraws the locked view, then notifies with merged state', async () => {
    await newCard();
    const raw = {
      state: {
        values: { b1: { 'ncu:c1:pick': { type: 'checkboxes', selected_options: [{ value: 'b' }] } } },
      },
    };
    await handleCardAction(ev('ncu:c1:create', { raw }), adapter, 'slack');
    const stored = (await getCard('c1'))!;
    expect(stored).toMatchObject({ locked: true, lockedBy: 'U1', state: { pick: ['b'] } });
    expect(methods()).toEqual(['chat.update']);
    expect(JSON.stringify(call.mock.calls[0][2])).toContain('Submitted');
    const payload = JSON.parse(write.mock.calls[0][2].content).payload;
    expect(payload).toMatchObject({ control: 'create', locked: true, state: { pick: ['b'] } });
  });

  it('submit without touching the checkboxes sends the seeded state', async () => {
    await newCard();
    await handleCardAction(ev('ncu:c1:create'), adapter, 'slack');
    expect(JSON.parse(write.mock.calls[0][2].content).payload.state).toEqual({ pick: ['a', 'b'] });
  });

  it('submit with notify:false locks but sends nothing', async () => {
    await newCard();
    await handleCardAction(ev('ncu:c1:quiet'), adapter, 'slack');
    expect((await getCard('c1'))!.locked).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes one agent message when the same click is delivered twice', async () => {
    await newCard();
    write
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: messages_in.id'));
    await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack');
    await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack');
    expect(write).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('two concurrent submits produce one lock', async () => {
    await newCard();
    const [a, b] = await Promise.all([
      handleCardAction(ev('ncu:c1:create', { raw: { action_ts: '1.1' } }), adapter, 'slack'),
      handleCardAction(ev('ncu:c1:create', { raw: { action_ts: '2.2' } }), adapter, 'slack'),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(write).toHaveBeenCalledTimes(1);
    const ephemerals = call.mock.calls.filter((c) => c[1] === 'chat.postEphemeral');
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0][2]).toMatchObject({ text: 'This was already submitted.' });
  });

  it('answers a press on a locked card', async () => {
    await newCard();
    await handleCardAction(ev('ncu:c1:create'), adapter, 'slack');
    vi.clearAllMocks();
    await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack');
    expect(call.mock.calls[0][2]).toMatchObject({ text: 'This was already submitted.' });
    expect(write).not.toHaveBeenCalled();
  });

  it('skips the message when the session is gone', async () => {
    await newCard();
    vi.mocked(getSession).mockResolvedValue(undefined);
    expect(await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack')).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('logs and returns true when the write fails for another reason', async () => {
    await newCard();
    write.mockRejectedValue(new Error('disk full'));
    expect(await handleCardAction(ev('ncu:c1:ok'), adapter, 'slack')).toBe(true);
    expect(wake).not.toHaveBeenCalled();
  });

  it('survives a failing chat.update', async () => {
    await newCard();
    call.mockRejectedValue(new Error('boom'));
    expect(await handleCardAction(ev('ncu:c1:create'), adapter, 'slack')).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('lets anyone press an open control', async () => {
    await newCard();
    await updateState('c1', { pick: ['a'] });
    await handleCardAction(ev('ncu:c1:open', { user: 'U9' }), adapter, 'slack');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
