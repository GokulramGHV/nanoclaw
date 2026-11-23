import type { Adapter, ModalSubmitEvent } from 'chat';
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
import './db/migrations.js';
import { handleKitFormSubmit } from './forms.js';
import { kit, registerCardEventHandler } from './kit.js';

const SOURCE = `root = Root([note])
$comment = ""
note = Form("Add a note", "Save", [TextInput("Note", $comment)])`;

const TS = '1700000000.000100';
const adapter = {} as Adapter;
const events: CardEvent[] = [];
let order: string[] = [];
let view: any;

async function postAndOpen(instance = 'slack') {
  const client = makeClient();
  await kit.postCard(client, { channel: 'C1' }, SOURCE, {
    owner: 'U1',
    trusted: true,
    placeholder: false,
    meta: { kind: 'card', cardId: 'card-1', template: 'demo', agentGroupId: 'ag-1', sessionId: 's-1', instance },
  });
  await kit.handleAction(client, {
    type: 'block_actions',
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: TS },
    trigger_id: 'trig',
    actions: [{ type: 'button', action_id: 'form:note' }],
  });
  view = fake.calls.find((c) => c.method === 'views.open')!.args.view;
  fake.calls.length = 0;
}

const submit = (user: string, value: string, over: Record<string, unknown> = {}) => {
  const block = view.blocks[0];
  const raw = {
    type: 'view_submission',
    user: { id: user },
    view: {
      ...view,
      state: { values: { [block.block_id]: { [block.element.action_id]: { type: 'plain_text_input', value } } } },
      ...over,
    },
  };
  return {
    raw,
    callbackId: raw.view.callback_id,
    privateMetadata: raw.view.private_metadata,
  } as unknown as ModalSubmitEvent;
};

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.hasToken = true;
  events.length = 0;
  order = [];
  registerCardEventHandler('card', async (e) => {
    order.push('event');
    events.push(e);
  });
});

afterEach(async () => {
  await closeDb();
});

describe('handleKitFormSubmit', () => {
  it('falls through for a modal that is not ours', async () => {
    await postAndOpen();
    expect(await handleKitFormSubmit(submit('U1', 'x', { callback_id: 'other' }), adapter, 'slack')).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('falls through when the hidden data is not ours or names no stored card', async () => {
    await postAndOpen();
    expect(await handleKitFormSubmit(submit('U1', 'x', { private_metadata: 'nope' }), adapter, 'slack')).toBe(false);
    expect(
      await handleKitFormSubmit(
        submit('U1', 'x', { private_metadata: JSON.stringify({ m: { channel: 'C9', ts: '9.9', formId: 'note' } }) }),
        adapter,
        'slack',
      ),
    ).toBe(false);
  });

  it('falls through when the card belongs to another instance', async () => {
    await postAndOpen('other');
    expect(await handleKitFormSubmit(submit('U1', 'x'), adapter, 'slack')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('closes the form at once and runs the save, lock and event after the reply', async () => {
    await postAndOpen();
    const reply = await handleKitFormSubmit(submit('U1', 'looks good'), adapter, 'slack');
    expect(reply).toBeUndefined();
    // done was not awaited by the handler: the event has not been written yet or lands right after.
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'submit', control: { id: 'form:note', kind: 'form' } });
    const card = await kit.getCard('C1', TS);
    expect(card?.state.$comment).toBe('looks good');
    expect(card?.locked?.by).toBe('U1');
  });

  it('does not wait for the work after the reply', async () => {
    await postAndOpen();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registerCardEventHandler('card', async (e) => {
      await gate;
      events.push(e);
    });
    const reply = await handleKitFormSubmit(submit('U1', 'x'), adapter, 'slack');
    expect(reply).toBeUndefined();
    expect(events).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(events).toHaveLength(1));
  });

  it('maps the kit field errors to the chat SDK errors response', async () => {
    await postAndOpen();
    const reply = await handleKitFormSubmit(submit('U2', 'x'), adapter, 'slack');
    const block = view.blocks[0];
    expect(reply).toEqual({ action: 'errors', errors: { [block.block_id]: 'Only <@U1> can do this.' } });
    expect(events).toHaveLength(0);
  });
});
