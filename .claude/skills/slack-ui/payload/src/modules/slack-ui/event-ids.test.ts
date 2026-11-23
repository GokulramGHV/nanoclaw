/**
 * Clicks and form submits through the real kit and the real card_event writer:
 * the message id comes from the Slack event (action_ts / view id), so two
 * different presses are two messages and a redelivered press is one.
 */
import type { ActionEvent, Adapter, ModalSubmitEvent } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));

const fake = vi.hoisted(() => ({ calls: [] as Array<{ method: string; args: any }> }));
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
  slackClientForInstance: () => makeClient(),
  slackClientForToken: () => makeClient(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { handleKitAction } from './clicks.js';
import './db/migrations.js';
import './events.js';
import { handleKitFormSubmit } from './forms.js';
import { kit } from './kit.js';

const TS = '1700000000.000100';
const adapter = {} as Adapter;
const written = new Set<string>();
const write = vi.mocked(writeSessionMessage);

const FEEDBACK = `root = Root([fb])
fb = Feedback("Helpful", "Not helpful")`;
const FORM = `root = Root([note])
$comment = ""
note = Form("Add a note", "Save", [TextInput("Note", $comment)])`;

async function post(source: string) {
  await kit.postCard(makeClient(), { channel: 'C1' }, source, {
    owner: 'U1',
    trusted: true,
    placeholder: false,
    meta: {
      kind: 'card',
      cardId: 'card-1',
      template: 'demo',
      agentGroupId: 'ag-1',
      sessionId: 's-1',
      instance: 'slack',
    },
  });
  fake.calls.length = 0;
}

const raw = (user: string, action: Record<string, unknown>) => ({
  type: 'block_actions',
  user: { id: user, name: `name-${user}` },
  channel: { id: 'C1' },
  container: { channel_id: 'C1', message_ts: TS },
  message: { ts: TS },
  trigger_id: 't',
  actions: [action],
});
const feedback = (user: string, value: string, actionTs: string) =>
  ({
    actionId: 'fb',
    user: { userId: user },
    raw: raw(user, { type: 'feedback_buttons', action_id: 'fb', value, action_ts: actionTs }),
  }) as unknown as ActionEvent;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fake.calls.length = 0;
  written.clear();
  vi.mocked(getSession).mockResolvedValue({ id: 's-1' } as never);
  write.mockImplementation(async (_g, _s, msg) => {
    if (written.has(msg.id))
      throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    written.add(msg.id);
  });
});

afterEach(async () => {
  await closeDb();
});

describe('card event message ids', () => {
  it('writes two events for two feedback presses on one card, with the clicker name', async () => {
    await post(FEEDBACK);
    await handleKitAction(feedback('U2', 'positive', '1700.1'), adapter, 'slack');
    await handleKitAction(feedback('U3', 'negative', '1700.2'), adapter, 'slack');
    expect([...written]).toEqual(['card-card-1-1700.1', 'card-card-1-1700.2']);
    const names = write.mock.calls.map((c) => JSON.parse(c[2].content).payload.user.name);
    expect(names).toEqual(['name-U2', 'name-U3']);
  });

  it('writes a redelivered press (same action_ts) once', async () => {
    await post(FEEDBACK);
    await handleKitAction(feedback('U2', 'positive', '1700.1'), adapter, 'slack');
    await handleKitAction(feedback('U2', 'positive', '1700.1'), adapter, 'slack');
    expect(write).toHaveBeenCalledTimes(2);
    expect(written.size).toBe(1);
  });

  it('keys a form submit by the view id', async () => {
    await post(FORM);
    await kit.handleAction(makeClient(), raw('U1', { type: 'button', action_id: 'form:note' }));
    const view = fake.calls.find((c) => c.method === 'views.open')!.args.view;
    const block = view.blocks[0];
    const submitRaw = {
      type: 'view_submission',
      user: { id: 'U1', name: 'ada' },
      view: {
        ...view,
        id: 'V123',
        state: {
          values: { [block.block_id]: { [block.element.action_id]: { type: 'plain_text_input', value: 'hi' } } },
        },
      },
    };
    const reply = await handleKitFormSubmit({ raw: submitRaw } as unknown as ModalSubmitEvent, adapter, 'slack');
    expect(reply).toBeUndefined();
    await vi.waitFor(() => expect(written.has('card-card-1-V123-sub')).toBe(true));
    const payload = JSON.parse(write.mock.calls[0]![2].content).payload;
    expect(payload.user).toEqual({ id: 'U1', name: 'ada' });
    expect(payload.value).toEqual({ comment: 'hi' });
  });
});
