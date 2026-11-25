import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  botTokenKeyForInstance: (i: string) => (i === 'slack' ? 'SLACK_BOT_TOKEN' : 'SLACK_BOT_TOKEN_X'),
}));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));
vi.mock('./notify.js', () => ({ notifyCardFailure: vi.fn() }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: vi.fn() }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../group-folder.js', () => ({ resolveGroupFolderPath: vi.fn() }));
vi.mock('../../session-manager.js', () => ({ sessionDir: vi.fn(), writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../typing/index.js', () => ({ pauseTypingRefreshAfterDelivery: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: any }>,
  updateError: undefined as unknown,
  tokens: [] as string[],
  posted: 0,
}));
vi.mock('./slack-client.js', () => ({
  slackClientForToken: (token: string) => {
    fake.tokens.push(token);
    return {
      chat: {
        postMessage: async (args: unknown) => {
          fake.calls.push({ method: 'chat.postMessage', args });
          fake.posted += 1;
          return { ok: true, ts: `1700000000.00${200 + fake.posted}` };
        },
        update: async (args: unknown) => {
          fake.calls.push({ method: 'chat.update', args });
          if (fake.updateError) throw fake.updateError;
          return { ok: true };
        },
        delete: async (args: unknown) => (fake.calls.push({ method: 'chat.delete', args }), { ok: true }),
        postEphemeral: async (args: unknown) => (fake.calls.push({ method: 'chat.postEphemeral', args }), { ok: true }),
      },
      views: { open: async () => ({ ok: true }) },
    };
  },
  slackClientForInstance: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { getDeliveryAction } from '../../delivery.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import type { Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import './index.js';
import { kit } from './kit.js';
import { notifyCardFailure } from './notify.js';
import { handlePostCard } from './post-card.js';
import { handleUpdateCard } from './update-card.js';

const notify = vi.mocked(notifyCardFailure);

const oui = `root = Root([hdr, status, pick])
$who = ""
$note = "default note"
$choice = ""
hdr = Section("Hello *" + $who + "*")
status = Section($note)
pick = Radio("Pick", $choice, [Option("a", "Alpha"), Option("b", "Beta")])`;

const templateJson = JSON.stringify({
  version: 2,
  data: { who: { type: 'string', required: true }, note: { type: 'string' } },
  openui: 'status.oui',
});

const session: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-01-01T00:00:00.000Z',
};
const otherSession: Session = { ...session, id: 'sess-2' };
const otherGroupSession: Session = { ...session, id: 'sess-3', agent_group_id: 'ag-2' };

const dirs: string[] = [];
let groupDir: string;

function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ui-uc-'));
  dirs.push(d);
  return d;
}

function writeTemplate(json: string, source: string = oui): void {
  const dir = path.join(groupDir, 'plugins', 'plugin-a', 'cards');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), json);
  fs.writeFileSync(path.join(dir, 'status.oui'), source);
}

const post = (over: Record<string, unknown> = {}) =>
  handlePostCard(
    { action: 'post_card', cardId: 'card-1', template: 'status', data: { who: 'world', note: 'Beginning' }, ...over },
    session,
  );

const update = (over: Record<string, unknown> = {}, s: Session = otherSession) =>
  handleUpdateCard({ action: 'update_card', cardId: 'card-1', data: { who: 'world', note: 'Complete' }, ...over }, s);

const updates = () => fake.calls.filter((c) => c.method === 'chat.update');

function failed(re: RegExp) {
  expect(updates()).toHaveLength(0);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][1]).toMatch(/^update_card failed: /);
  expect(notify.mock.calls[0][1]).toMatch(re);
  expect(notify.mock.calls[0][1]).not.toContain(groupDir);
  expect(notify.mock.calls[0][1]).not.toContain('xoxb-secret');
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.tokens.length = 0;
  fake.posted = 0;
  fake.updateError = undefined;
  groupDir = mkdir();
  writeTemplate(templateJson);
  vi.mocked(resolveGroupFolderPath).mockReturnValue(groupDir);
  vi.mocked(getAgentGroup).mockResolvedValue({ id: 'ag-1', folder: 'g1' } as never);
  vi.mocked(getMessagingGroup).mockResolvedValue({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C123',
  } as never);
  vi.mocked(envValue).mockReturnValue('xoxb-secret');
  await post();
  fake.calls.length = 0;
  fake.tokens.length = 0;
});

afterEach(async () => {
  await closeDb();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('update_card', () => {
  it('registers update_card as a delivery action', () => {
    expect(getDeliveryAction('update_card')).toBe(handleUpdateCard);
  });

  it("updates its own group's card from another session, in place", async () => {
    const before = await getCardById('card-1');
    await update();
    expect(notify).not.toHaveBeenCalled();
    expect(fake.calls.map((c) => c.method)).toEqual(['chat.update']);
    expect(fake.calls[0]!.args).toMatchObject({ channel: 'C123', ts: before!.ts });
    expect(JSON.stringify(fake.calls[0]!.args.blocks)).toContain('Complete');
    expect(fake.tokens).toEqual(['xoxb-secret']);
    const after = await getCardById('card-1');
    expect(after).toMatchObject({ owner: before!.owner, ts: before!.ts, version: before!.version + 1 });
    expect(after?.meta).toMatchObject({ sessionId: 'sess-1', template: 'status' });
    expect(after?.state).toMatchObject({ $who: 'world', $note: 'Complete' });
  });

  it('keeps state the template source owns and replaces or drops declared fields', async () => {
    const card = (await getCardById('card-1'))!;
    await kit.store.put({ ...card, state: { ...card.state, $choice: 'b' }, version: card.version + 1 }, card.version);
    await update({ data: { who: 'again' } });
    expect(notify).not.toHaveBeenCalled();
    const after = await getCardById('card-1');
    expect(after?.state.$choice).toBe('b');
    expect(after?.state.$who).toBe('again');
    // note was declared and not sent: back to the source default, not the old value.
    expect(after?.state.$note).toBe('default note');
    expect(JSON.stringify(after?.blocks)).not.toContain('Beginning');
  });

  it('entity-escapes the new data', async () => {
    await update({ data: { who: 'w', note: 'a <!channel> & b' } });
    expect((await getCardById('card-1'))?.state.$note).toBe('a &lt;!channel&gt; &amp; b');
  });

  it('keeps a locked card locked, with no live controls and the same footer', async () => {
    await kit.closeCard(
      (await import('./slack-client.js')).slackClientForToken('t') as never,
      'C123',
      (await getCardById('card-1'))!.ts,
      { note: 'Replaced by a newer version.' },
    );
    fake.calls.length = 0;
    await update();
    expect(notify).not.toHaveBeenCalled();
    const after = await getCardById('card-1');
    expect(after?.locked).toMatchObject({ note: 'Replaced by a newer version.' });
    const text = JSON.stringify(updates()[0]!.args.blocks);
    expect(text).toContain('Complete');
    expect(text).toContain('Replaced by a newer version.');
    expect(text).not.toContain('radio_buttons');
  });

  it('uses the template found now, so an edited template is picked up', async () => {
    writeTemplate(templateJson, oui.replace('"Hello *"', '"Howdy *"'));
    await update();
    expect(JSON.stringify(updates()[0]!.args.blocks)).toContain('Howdy');
  });

  it('saves the template access it has now and keeps the owner', async () => {
    const before = (await getCardById('card-1'))!;
    writeTemplate(JSON.stringify({ ...JSON.parse(templateJson), access: { default: 'anyone' } }));
    await update();
    expect(notify).not.toHaveBeenCalled();
    const after = (await getCardById('card-1'))!;
    expect(after.access).toEqual({ default: 'anyone' });
    expect(after.owner).toBe(before.owner);
  });

  it('turns a card that stays busy into a notice and changes nothing', async () => {
    const card = (await getCardById('card-1'))!;
    await kit.store.put(
      {
        ...card,
        locked: { by: 'U1', at: new Date().toISOString(), label: 'Go' },
        finishing: true,
        version: card.version + 1,
      },
      card.version,
    );
    await update();
    failed(/busy/);
    expect((await getCardById('card-1'))?.state.$note).toBe('Beginning');
  }, 10000);

  it("refuses another agent group's card", async () => {
    await update({}, otherGroupSession);
    failed(/no card with that id/);
    expect((await getCardById('card-1'))?.state.$note).toBe('Beginning');
  });

  it('refuses an unknown card id', async () => {
    await update({ cardId: 'nope' });
    failed(/no card with that id/);
  });

  it("refuses a card whose kind is not 'card'", async () => {
    const card = (await getCardById('card-1'))!;
    await kit.registerCard({
      channel: 'C123',
      ts: '1700000000.000999',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'q' } }],
      owner: 'U1',
      meta: { kind: 'ask', cardId: 'ask-1', agentGroupId: 'ag-1', sessionId: 'sess-1', instance: 'slack' },
    });
    expect(card).toBeDefined();
    await update({ cardId: 'ask-1' });
    failed(/no card with that id/);
  });

  it('turns a data validation failure into a notice and changes nothing', async () => {
    await update({ data: { who: 'w', extra: 1 } });
    failed(/extra/);
    await update({ data: {} });
    expect((await getCardById('card-1'))?.state.$note).toBe('Beginning');
  });

  it('rejects a missing cardId and a missing token', async () => {
    await update({ cardId: '' });
    failed(/invalid cardId/);
    notify.mockClear();
    await update({ cardId: 'a b/c' });
    failed(/invalid cardId/);
    notify.mockClear();
    vi.mocked(envValue).mockReturnValue(undefined);
    await update();
    failed(/not configured/);
  });

  it("a Slack error becomes a notice with Slack's code and never throws", async () => {
    fake.updateError = Object.assign(new Error('message_not_found'), { name: 'SlackApiError' });
    await expect(update()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toMatch(/^update_card failed: .*message_not_found/);
  });

  it('does not throw when the failure notice itself fails', async () => {
    notify.mockRejectedValueOnce(new Error('down'));
    await expect(update({ cardId: 'nope' })).resolves.toBeUndefined();
  });
});
