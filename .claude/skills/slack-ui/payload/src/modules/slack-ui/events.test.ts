import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDeliveryError, type CardEvent, type CardRecord } from 'slack-ui-kit';

vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { noteEventContext, writeCardEvent } from './events.js';
import { kit, recoverKitError, routeCardEvent } from './kit.js';

const write = vi.mocked(writeSessionMessage);

const card = (over: Partial<CardRecord> = {}): CardRecord =>
  ({
    channel: 'C1',
    ts: '1.1',
    owner: 'U1',
    access: {},
    trusted: true,
    kind: 'openui',
    state: {},
    text: '',
    blocks: [],
    controls: {},
    forms: {},
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as CardRecord;

const event = (over: Partial<CardEvent> = {}): CardEvent => ({
  type: 'action',
  card: { channel: 'C1', ts: '1.1', threadTs: '1.0' },
  user: 'U2',
  control: { id: 'go', kind: 'button', value: 'create' },
  state: { $pick: ['a'], $choice: 'create' },
  locked: { by: 'U2', at: '2026-01-01T00:00:00.000Z', label: 'Go' },
  meta: { kind: 'card', cardId: 'card-1', template: 'demo', agentGroupId: 'ag-1', sessionId: 's-1', instance: 'slack' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ id: 's-1' } as never);
  vi.spyOn(kit, 'getCard').mockResolvedValue(card());
});

describe('writeCardEvent', () => {
  it('writes the card_event message in the agent shape, then wakes the session', async () => {
    await writeCardEvent(event());
    expect(write).toHaveBeenCalledTimes(1);
    const [group, sess, msg] = write.mock.calls[0]!;
    expect(group).toBe('ag-1');
    expect(sess).toBe('s-1');
    expect(msg.id).toMatch(/^card-card-1-v3-[a-z0-9]+$/);
    expect(msg).toMatchObject({
      kind: 'webhook',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: 'slack:C1:1.0',
    });
    expect(JSON.parse(msg.content)).toEqual({
      source: 'slack-ui',
      event: 'card_event',
      payload: {
        cardId: 'card-1',
        template: 'demo',
        control: 'go',
        value: 'create',
        user: { id: 'U2', name: '' },
        state: { pick: ['a'], choice: 'create' },
        locked: true,
      },
    });
    expect(requestWake).toHaveBeenCalledWith({ id: 's-1' }, 'interactive');
  });

  it('uses the press action_ts and the clicker name when the click handler noted them', async () => {
    noteEventContext('C1', '1.1', 'U2', { actionTs: '1700.5', userName: 'ada' });
    await writeCardEvent(event());
    const [, , msg] = write.mock.calls[0]!;
    expect(msg.id).toBe('card-card-1-1700.5');
    expect(JSON.parse(msg.content).payload.user).toEqual({ id: 'U2', name: 'ada' });
  });

  it('uses the view id for a form submit, and strips $ from the submitted values', async () => {
    noteEventContext('C1', '1.1', 'U2', { viewId: 'V99' });
    await writeCardEvent(
      event({ type: 'submit', control: { id: 'form:note', kind: 'form', value: { $comment: 'hi' } } }),
    );
    const [, , msg] = write.mock.calls[0]!;
    expect(msg.id).toBe('card-card-1-V99-sub');
    expect(JSON.parse(msg.content).payload.value).toEqual({ comment: 'hi' });
  });

  it('keeps the noted context for a retry after a failed write, and drops it after success', async () => {
    noteEventContext('C1', '1.1', 'U2', { actionTs: '7.7' });
    write.mockRejectedValueOnce(new Error('disk full'));
    await expect(writeCardEvent(event())).rejects.toThrow();
    await writeCardEvent(event());
    expect(write.mock.calls[1]![2].id).toBe('card-card-1-7.7');
    await writeCardEvent(event());
    expect(write.mock.calls[2]![2].id).toMatch(/^card-card-1-v3-/);
  });

  it('marks an unlocked event, a null value and a top-level card', async () => {
    await writeCardEvent(
      event({ locked: undefined, control: { id: 'pick', kind: 'input' }, card: { channel: 'C1', ts: '1.1' } }),
    );
    const [, , msg] = write.mock.calls[0]!;
    expect(msg.threadId).toBeNull();
    expect(JSON.parse(msg.content).payload).toMatchObject({ control: 'pick', value: null, locked: false });
  });

  it('uses the stored card it is given instead of reading the store', async () => {
    await writeCardEvent(event(), card({ version: 7 }));
    expect(write.mock.calls[0]![2].id).toMatch(/^card-card-1-v7-/);
    expect(kit.getCard).not.toHaveBeenCalled();
  });

  it('ignores a duplicate message id and does not wake the session', async () => {
    write.mockRejectedValueOnce(
      Object.assign(new Error('UNIQUE constraint failed: messages_in.id'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }),
    );
    await expect(writeCardEvent(event())).resolves.toBeUndefined();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('rethrows other write errors so the kit reports an EventDeliveryError', async () => {
    write.mockRejectedValueOnce(new Error('disk full'));
    await expect(writeCardEvent(event())).rejects.toThrow('disk full');
  });

  it('writes nothing for an event without host metadata, a missing card or a missing session', async () => {
    await writeCardEvent(event({ meta: { kind: 'card' } }));
    vi.mocked(kit.getCard).mockResolvedValueOnce(undefined);
    await writeCardEvent(event());
    vi.mocked(getSession).mockResolvedValueOnce(undefined);
    await writeCardEvent(event());
    expect(write).not.toHaveBeenCalled();
  });
});

describe('card event routing and recovery', () => {
  it('routes a card event to the registered card writer', async () => {
    await routeCardEvent(event());
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('logs and drops an event whose kind has no handler', async () => {
    await routeCardEvent(event({ meta: { kind: 'nope' } }));
    expect(write).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('retries the event once after an EventDeliveryError, using the stored card version', async () => {
    const err = new EventDeliveryError(event(), card({ version: 5 }), new Error('disk full'));
    await recoverKitError(err);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![2].id).toMatch(/^card-card-1-v5-/);
    expect(log.error).toHaveBeenCalled();
  });

  it('does not retry a second time and never throws', async () => {
    write.mockRejectedValue(new Error('still down'));
    await expect(recoverKitError(new EventDeliveryError(event(), card(), new Error('x')))).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('only logs an error that is not an EventDeliveryError', async () => {
    await recoverKitError(new Error('other'));
    expect(write).not.toHaveBeenCalled();
  });
});
