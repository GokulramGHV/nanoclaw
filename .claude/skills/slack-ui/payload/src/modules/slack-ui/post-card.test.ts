import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
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
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: any }>,
  postError: undefined as unknown,
  tokens: [] as string[],
}));
vi.mock('./slack-client.js', () => ({
  slackClientForToken: (token: string) => {
    fake.tokens.push(token);
    return {
      chat: {
        postMessage: async (args: unknown) => {
          fake.calls.push({ method: 'chat.postMessage', args });
          if (fake.postError) throw fake.postError;
          return { ok: true, ts: '1700000000.000200' };
        },
        update: async (args: unknown) => (fake.calls.push({ method: 'chat.update', args }), { ok: true }),
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
import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import './index.js';
import { notifyCardFailure } from './notify.js';
import { kit } from './kit.js';
import { handlePostCard, readInboundSender } from './post-card.js';

const notify = vi.mocked(notifyCardFailure);

const oui = `root = Root([hdr, pick, acts])
$who = ""
$items = []
$pick = []
$choice = ""
hdr = Section("Hello *" + $who + "*")
pick = Checkboxes("pick", $pick, @Each($items, "it", Option(it.name, it.name)))
acts = Actions([go])
go = Button("Go", Action([@Set($choice, "go")]), "primary")`;

const templateJson = JSON.stringify({
  version: 2,
  data: {
    who: { type: 'string', required: true },
    items: { type: 'array', items: { name: { type: 'string' }, selected: { type: 'boolean' } } },
  },
  access: { byId: { go: 'anyone' } },
  openui: 'demo-request.oui',
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

const dirs: string[] = [];
let groupDir: string;
let sessDir: string;

function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ui-pc-'));
  dirs.push(d);
  return d;
}

function writeTemplate(name: string, json: string, source: string | null = oui, plugin = 'plugin-a'): void {
  const dir = path.join(groupDir, 'plugins', plugin, 'cards');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), json);
  if (source !== null) fs.writeFileSync(path.join(dir, `${name.replace(/\.json$/, '')}.oui`), source);
}

type SeedRow = { id: string; kind: string; content: string; trigger?: 0 | 1; seq?: number };

/** Seeds rows into a real inbound.db schema. seq defaults to even numbers in row order. */
function seedInbound(rows: SeedRow[]): void {
  const db = new Database(path.join(sessDir, 'inbound.db'));
  db.exec(INBOUND_SCHEMA);
  const insert = db.prepare(
    'INSERT INTO messages_in (id, seq, kind, timestamp, "trigger", content) VALUES (?, ?, ?, ?, ?, ?)',
  );
  rows.forEach((r, i) =>
    insert.run(r.id, r.seq ?? (i + 1) * 2, r.kind, '2026-01-01T00:00:00.000Z', r.trigger ?? 1, r.content),
  );
  db.close();
}

const chatRow = (id: string, sender: string, over: Partial<SeedRow> = {}): SeedRow => ({
  id,
  kind: 'chat',
  content: JSON.stringify({ text: 'x', senderId: sender }),
  ...over,
});

const post = (over: Record<string, unknown> = {}, s: Session = session) =>
  handlePostCard(
    {
      action: 'post_card',
      cardId: 'card-1',
      template: 'demo-request',
      data: { who: 'world', items: [{ name: 'a', selected: true }] },
      ...over,
    },
    s,
  );

const posts = () => fake.calls.filter((c) => c.method === 'chat.postMessage');

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.tokens.length = 0;
  fake.postError = undefined;
  groupDir = mkdir();
  sessDir = mkdir();
  writeTemplate('demo-request', templateJson);
  vi.mocked(resolveGroupFolderPath).mockReturnValue(groupDir);
  vi.mocked(sessionDir).mockReturnValue(sessDir);
  vi.mocked(getAgentGroup).mockResolvedValue({ id: 'ag-1', folder: 'g1' } as never);
  vi.mocked(getMessagingGroup).mockResolvedValue({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C123',
  } as never);
  vi.mocked(envValue).mockReturnValue('xoxb-secret');
});

afterEach(async () => {
  await closeDb();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('registration', () => {
  it('registers post_card as a delivery action', () => {
    expect(getDeliveryAction('post_card')).toBe(handlePostCard);
  });
});

describe('post_card', () => {
  it('posts the OpenUI card to the session channel and saves it with host metadata', async () => {
    await post();
    expect(posts()).toHaveLength(1);
    const body = posts()[0]!.args;
    expect(fake.tokens).toEqual(['xoxb-secret']);
    expect(body).toMatchObject({ channel: 'C123' });
    expect(body).not.toHaveProperty('thread_ts');
    expect(JSON.stringify(body.blocks)).toContain('Hello *world*');
    expect(JSON.stringify(body.blocks)).toContain('"action_id":"go"');
    // No placeholder message: one post, no update.
    expect(fake.calls.map((c) => c.method)).toEqual(['chat.postMessage']);

    const card = await getCardById('card-1');
    expect(card).toMatchObject({
      channel: 'C123',
      ts: '1700000000.000200',
      trusted: true,
      kind: 'openui',
      access: { byId: { go: 'anyone' } },
      meta: {
        kind: 'card',
        cardId: 'card-1',
        template: 'demo-request',
        agentGroupId: 'ag-1',
        sessionId: 'sess-1',
        instance: 'slack',
      },
    });
    expect(card?.state).toMatchObject({ $who: 'world', $items: [{ name: 'a', selected: true }] });
    expect(notify).not.toHaveBeenCalled();
  });

  it('entity-escapes every string in the data, recursively, before it becomes state', async () => {
    await post({ data: { who: 'a & <b>', items: [{ name: 'x>y & z' }] } });
    const card = await getCardById('card-1');
    expect(card?.state.$who).toBe('a &amp; &lt;b&gt;');
    expect(card?.state.$items).toEqual([{ name: 'x&gt;y &amp; z' }]);
    expect(JSON.stringify(posts()[0]!.args.blocks)).toContain('a &amp; &lt;b&gt;');
  });

  it('uses threadId when it names the same channel', async () => {
    await post({ threadId: 'slack:C123:1699999999.000100' });
    expect(posts()[0]!.args).toMatchObject({ thread_ts: '1699999999.000100' });
    expect((await getCardById('card-1'))?.threadTs).toBe('1699999999.000100');
  });

  it('ignores a threadId for another channel and falls back to session.thread_id', async () => {
    await post({ threadId: 'slack:C999:1.1' }, { ...session, thread_id: 'slack:C123:1698.5' });
    expect(posts()[0]!.args).toMatchObject({ thread_ts: '1698.5' });
  });

  it('goes top-level when neither thread matches', async () => {
    await post({ threadId: 'bogus' }, { ...session, thread_id: 'slack:C999:1.1' });
    expect(posts()[0]!.args).not.toHaveProperty('thread_ts');
    expect((await getCardById('card-1'))?.threadTs).toBeUndefined();
  });

  it('uses the instance-specific token and records the instance', async () => {
    vi.mocked(getMessagingGroup).mockResolvedValue({
      id: 'mg-1',
      channel_type: 'slack',
      platform_id: 'C123',
      instance: 'other',
    } as never);
    await post();
    expect(vi.mocked(envValue)).toHaveBeenCalledWith('SLACK_BOT_TOKEN_X');
    expect((await getCardById('card-1'))?.meta?.instance).toBe('other');
  });

  describe('template format', () => {
    it('refuses a version 1 template with the exact text', async () => {
      writeTemplate('old', JSON.stringify({ version: 1, text: 't', data: {}, controls: {}, blocks: [] }), null);
      await post({ template: 'old' });
      expect(posts()).toHaveLength(0);
      expect(notify.mock.calls[0]![1]).toBe(
        'post_card failed: template old uses the old JSON block format; rewrite it in OpenUI Lang (see the slack-ui skill)',
      );
    });

    it('treats a template with no version as version 1', async () => {
      writeTemplate('noversion', JSON.stringify({ data: {}, openui: 'noversion.oui' }), null);
      await post({ template: 'noversion' });
      expect(notify.mock.calls[0]![1]).toMatch(/template noversion uses the old JSON block format/);
    });

    it.each(['../x.oui', 'sub/x.oui', 'x.txt', '..', '', 'a\\b.oui'])('refuses the openui name %j', async (name) => {
      writeTemplate('bad', JSON.stringify({ version: 2, data: {}, openui: name }), null);
      await post({ template: 'bad', data: {} });
      expect(posts()).toHaveLength(0);
      expect(notify.mock.calls[0]![1]).toMatch(/^post_card failed: .*openui must be the plain file name/);
    });

    it('refuses a template whose .oui file is missing', async () => {
      writeTemplate('nofile', JSON.stringify({ version: 2, data: {}, openui: 'nofile.oui' }), null);
      await post({ template: 'nofile', data: {} });
      expect(notify.mock.calls[0]![1]).toMatch(/cannot read nofile\.oui/);
      expect(notify.mock.calls[0]![1]).not.toContain(groupDir);
    });

    it('refuses a malformed access setting', async () => {
      writeTemplate(
        'badaccess',
        JSON.stringify({ version: 2, data: {}, openui: 'badaccess.oui', access: { buttons: 'nobody' } }),
      );
      await post({ template: 'badaccess', data: {} });
      expect(notify.mock.calls[0]![1]).toMatch(/access\.buttons must be/);
    });
  });

  describe('redelivery', () => {
    it('posts nothing, silently, when the same session already posted it', async () => {
      await post();
      fake.calls.length = 0;
      await post();
      expect(fake.calls).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it('refuses a card id owned by another session', async () => {
      await post();
      fake.calls.length = 0;
      await post({}, { ...session, id: 'sess-2' });
      expect(fake.calls).toHaveLength(0);
      expect(notify.mock.calls[0]![1]).toBe('post_card failed: card id already in use');
    });
  });

  describe('owner', () => {
    it('is the sender of the inReplyTo chat message, slack: prefix stripped', async () => {
      seedInbound([{ id: 'm1', kind: 'chat', content: JSON.stringify({ text: 'x', senderId: 'slack:U42' }) }]);
      await post({ inReplyTo: 'm1' });
      expect((await getCardById('card-1'))?.owner).toBe('U42');
    });

    it('is the clicker for a slack-ui card_event webhook row', async () => {
      seedInbound([
        {
          id: 'm2',
          kind: 'webhook',
          content: JSON.stringify({ source: 'slack-ui', event: 'card_event', payload: { user: { id: 'U77' } } }),
        },
      ]);
      await post({ inReplyTo: 'm2' });
      expect((await getCardById('card-1'))?.owner).toBe('U77');
    });

    it('skips a context row from someone else and takes the next triggering sender', async () => {
      seedInbound([chatRow('ctx', 'slack:UY', { trigger: 0 }), chatRow('trig', 'slack:UX')]);
      await post({ inReplyTo: 'ctx' });
      expect((await getCardById('card-1'))?.owner).toBe('UX');
    });

    it('is the triggering row sender when inReplyTo is that row', async () => {
      seedInbound([chatRow('ctx', 'slack:UY', { trigger: 0 }), chatRow('trig', 'slack:UX')]);
      await post({ inReplyTo: 'trig' });
      expect((await getCardById('card-1'))?.owner).toBe('UX');
    });

    it('is empty (matches nobody) when no triggering row follows a context row', async () => {
      seedInbound([chatRow('old', 'slack:UX'), chatRow('ctx', 'slack:UY', { trigger: 0 })]);
      await post({ inReplyTo: 'ctx' });
      expect(posts()).toHaveLength(1);
      expect((await getCardById('card-1'))?.owner).toBe('');
    });

    it('is empty without inReplyTo, and the card still posts', async () => {
      await post();
      expect(posts()).toHaveLength(1);
      expect((await getCardById('card-1'))?.owner).toBe('');
    });
  });

  describe('errors become a notice and nothing is posted', () => {
    const failed = (re: RegExp) => {
      expect(posts()).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][1]).toMatch(/^post_card failed: /);
      expect(notify.mock.calls[0][1]).toMatch(re);
      expect(notify.mock.calls[0][1]).not.toContain(groupDir);
      expect(notify.mock.calls[0][1]).not.toContain('xoxb-secret');
    };

    it('non-Slack messaging group', async () => {
      vi.mocked(getMessagingGroup).mockResolvedValue({
        id: 'mg-1',
        channel_type: 'telegram',
        platform_id: 'x',
      } as never);
      await post();
      failed(/Slack/);
    });

    it('no messaging group', async () => {
      await post({}, { ...session, messaging_group_id: null });
      failed(/no chat/);
      vi.mocked(getMessagingGroup).mockResolvedValue(undefined);
      notify.mockClear();
      await post();
      failed(/no chat/);
    });

    it('missing token', async () => {
      vi.mocked(envValue).mockReturnValue(undefined);
      await post();
      failed(/not configured/);
    });

    it('missing template', async () => {
      await post({ template: 'nope' });
      failed(/no card template "nope"/);
    });

    it('invalid data', async () => {
      await post({ data: { who: 'w', extra: 1 } });
      failed(/extra/);
      expect(await getCardById('card-1')).toBeUndefined();
    });

    it('bad cardId', async () => {
      await post({ cardId: 'a b/c' });
      failed(/cardId/);
      notify.mockClear();
      await post({ cardId: 'x'.repeat(65) });
      failed(/cardId/);
      notify.mockClear();
      await post({ cardId: 5 });
      failed(/cardId/);
    });

    it('missing template name', async () => {
      await post({ template: '' });
      failed(/template is required/);
    });
  });

  it("a Slack error saves nothing and notifies the agent with Slack's code", async () => {
    const { SlackApiError } =
      await vi.importActual<typeof import('../../channels/slack-lib.js')>('../../channels/slack-lib.js');
    fake.postError = Object.assign(new SlackApiError('post_card', 'slack chat.postMessage failed: channel_not_found'), {
      data: { error: 'channel_not_found' },
    });
    await post();
    expect(await getCardById('card-1')).toBeUndefined();
    expect(notify.mock.calls[0]![1]).toMatch(/^post_card failed: .*channel_not_found/);
  });

  it('a rejected card (invalid_blocks) becomes the kit text in the notice', async () => {
    fake.postError = Object.assign(new Error('slack chat.postMessage failed: invalid_blocks'), {
      data: { error: 'invalid_blocks' },
    });
    await post();
    expect(await getCardById('card-1')).toBeUndefined();
    expect(notify.mock.calls[0]![1]).toMatch(/^post_card failed: .+/);
    expect(notify.mock.calls[0]![1]).not.toBe('post_card failed: unexpected error (see host log)');
  });

  it('a template that cannot be rendered gets its own notice, without paths or tokens', async () => {
    vi.spyOn(kit, 'render').mockRejectedValueOnce(
      new Error(`parse failed at ${groupDir}/plugins/x.oui with xoxb-secret-1\nstack line`),
    );
    await post();
    expect(posts()).toHaveLength(0);
    const text = notify.mock.calls[0]![1] as string;
    expect(text).toMatch(/^post_card failed: template demo-request could not be rendered: parse failed at \[path\]/);
    expect(text).not.toContain(groupDir);
    expect(text).not.toContain('xoxb-secret');
    expect(text).not.toContain('stack line');
  });

  it('an unexpected error is hidden behind a generic notice and never thrown', async () => {
    vi.mocked(envValue).mockImplementation(() => {
      throw new Error('secret xoxb-secret leaked');
    });
    await expect(post()).resolves.toBeUndefined();
    expect(notify.mock.calls[0][1]).toBe('post_card failed: unexpected error (see host log)');
  });

  it('passes the message the card answered to the failure notice', async () => {
    await post({ template: 'nope', inReplyTo: 'msg-9' });
    expect(notify.mock.calls[0]![2]).toBe('msg-9');
    notify.mockClear();
    await post({ template: 'nope', cardId: 'card-2', inReplyTo: 42 });
    expect(notify.mock.calls[0]![2]).toBeUndefined();
  });

  it('does not throw when the failure notice itself fails', async () => {
    notify.mockRejectedValue(new Error('boom'));
    await expect(post({ template: 'nope' })).resolves.toBeUndefined();
  });
});

describe('readInboundSender', () => {
  it('returns null for system, empty, missing row, bad JSON and unreadable DB', () => {
    seedInbound([
      { id: 'sys', kind: 'chat', content: JSON.stringify({ senderId: 'system' }) },
      { id: 'empty', kind: 'chat', content: JSON.stringify({ senderId: '' }) },
      { id: 'bad', kind: 'chat', content: '{nope' },
    ]);
    expect(readInboundSender(session, 'sys')).toBeNull();
    expect(readInboundSender(session, 'empty')).toBeNull();
    expect(readInboundSender(session, 'missing')).toBeNull();
    expect(readInboundSender(session, 'bad')).toBeNull();
    expect(readInboundSender(session, undefined)).toBeNull();
    vi.mocked(sessionDir).mockReturnValue(path.join(sessDir, 'nonexistent'));
    expect(readInboundSender(session, 'sys')).toBeNull();
  });

  it('passes a bare Slack id through unchanged', () => {
    seedInbound([{ id: 'u', kind: 'chat', content: JSON.stringify({ senderId: 'U9' }) }]);
    expect(readInboundSender(session, 'u')).toBe('U9');
  });
});

describe('readInboundSender row choice', () => {
  const cardEvent = (id: string, user: string, over: Partial<SeedRow> = {}): SeedRow => ({
    id,
    kind: 'webhook',
    content: JSON.stringify({ source: 'slack-ui', event: 'card_event', payload: { user: { id: user } } }),
    ...over,
  });

  it('skips a row of another kind and later rows that are not chat or a card event', () => {
    seedInbound([
      { id: 'task', kind: 'task', content: JSON.stringify({ prompt: 'p' }) },
      { id: 'hook', kind: 'webhook', content: JSON.stringify({ source: 'other', senderId: 'UH' }) },
      chatRow('ctx', 'UY', { trigger: 0 }),
      { id: 'sdk', kind: 'chat-sdk', content: JSON.stringify({ senderId: 'slack:UX' }) },
    ]);
    expect(readInboundSender(session, 'task')).toBe('UX');
  });

  it('accepts a later slack-ui card event as the triggering row', () => {
    seedInbound([chatRow('ctx', 'UY', { trigger: 0 }), cardEvent('click', 'UC')]);
    expect(readInboundSender(session, 'ctx')).toBe('UC');
  });

  it('takes the earliest triggering row by seq, not by insert order', () => {
    seedInbound([
      chatRow('ctx', 'UY', { trigger: 0, seq: 2 }),
      chatRow('late', 'UL', { seq: 8 }),
      chatRow('early', 'UE', { seq: 4 }),
    ]);
    expect(readInboundSender(session, 'ctx')).toBe('UE');
  });

  it('ignores triggering rows that came before the inReplyTo row', () => {
    seedInbound([chatRow('before', 'UB', { seq: 2 }), chatRow('ctx', 'UY', { trigger: 0, seq: 4 })]);
    expect(readInboundSender(session, 'ctx')).toBeNull();
  });
  // Seen live: after `post_card failed`, the agent re-posts in reply to that
  // system notice. The owner is the person it was answering before the notice.
  it('uses the last earlier person when the inReplyTo row is a system notice', () => {
    seedInbound([
      chatRow('ask', 'U1'),
      chatRow('ctx', 'UB', { trigger: 0 }),
      chatRow('sys-1', 'system'),
      chatRow('sys-2', 'system'),
    ]);
    expect(readInboundSender(session, 'sys-1')).toBe('U1');
    expect(readInboundSender(session, 'sys-2')).toBe('U1');
  });

  it('accepts an earlier card event presser when replying to a system notice', () => {
    seedInbound([chatRow('ask', 'U1'), cardEvent('press', 'U2'), chatRow('sys-1', 'system')]);
    expect(readInboundSender(session, 'sys-1')).toBe('U2');
  });

  it('stays null for a system notice with no earlier person', () => {
    seedInbound([chatRow('ctx', 'UB', { trigger: 0 }), chatRow('sys-1', 'system')]);
    expect(readInboundSender(session, 'sys-1')).toBeNull();
  });

  const failNotice = (id: string, cardInReplyTo: string): SeedRow => ({
    id,
    kind: 'chat',
    content: JSON.stringify({ text: 'post_card failed: x', sender: 'system', senderId: 'system', cardInReplyTo }),
  });

  it('follows a failure notice to the message the failed card answered, not the latest person', () => {
    seedInbound([chatRow('ask', 'UA'), chatRow('other', 'UB'), failNotice('sys-1', 'ask')]);
    expect(readInboundSender(session, 'sys-1')).toBe('UA');
  });

  it('follows a chain of failure notices', () => {
    seedInbound([
      chatRow('ask', 'UA'),
      chatRow('other', 'UB'),
      failNotice('sys-1', 'ask'),
      failNotice('sys-2', 'sys-1'),
    ]);
    expect(readInboundSender(session, 'sys-2')).toBe('UA');
  });

  it('stops on a notice loop instead of recursing forever', () => {
    seedInbound([chatRow('ask', 'UA'), failNotice('sys-1', 'sys-2'), failNotice('sys-2', 'sys-1')]);
    expect(readInboundSender(session, 'sys-1')).toBe('UA');
  });
});
