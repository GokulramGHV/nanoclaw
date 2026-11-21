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
vi.mock('../approvals/primitive.js', () => ({ notifyAgent: vi.fn() }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: vi.fn() }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../group-folder.js', () => ({ resolveGroupFolderPath: vi.fn() }));
vi.mock('../../session-manager.js', () => ({ sessionDir: vi.fn(), writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { slackCall } from '../../channels/slack-lib.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { getDeliveryAction } from '../../delivery.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';
import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/primitive.js';
import { getCard, insertCard, setMessageTs } from './db/ui-cards.js';
import './index.js';
import { parseTemplate } from './template.js';
import { handlePostCard, readInboundSender } from './post-card.js';

vi.mock('./db/ui-cards.js', async (orig) => {
  const actual = await orig<typeof import('./db/ui-cards.js')>();
  return { ...actual, setMessageTs: vi.fn(actual.setMessageTs) };
});

const call = vi.mocked(slackCall);
const notify = vi.mocked(notifyAgent);

const templateJson = JSON.stringify({
  version: 1,
  text: 'Hi {{who}}',
  data: {
    who: { type: 'string', required: true },
    items: { type: 'array', items: { name: { type: 'string' }, selected: { type: 'boolean' } } },
  },
  controls: { go: { who: 'owner', submit: true } },
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: 'Hello *{{who}}*' } },
    {
      type: 'actions',
      elements: [
        {
          type: 'checkboxes',
          action_id: 'pick',
          options: [
            {
              $each: 'items',
              as: 'it',
              do: { text: { type: 'plain_text', text: '{{it.name}}' }, value: '{{it.name}}', $selected: 'it.selected' },
            },
          ],
        },
        { type: 'button', action_id: 'go', text: { type: 'plain_text', text: 'Go' } },
      ],
    },
  ],
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

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  groupDir = mkdir();
  sessDir = mkdir();
  fs.mkdirSync(path.join(groupDir, 'plugins/plugin-a/cards'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'plugins/plugin-a/cards/demo-request.json'), templateJson);
  vi.mocked(resolveGroupFolderPath).mockReturnValue(groupDir);
  vi.mocked(sessionDir).mockReturnValue(sessDir);
  vi.mocked(getAgentGroup).mockResolvedValue({ id: 'ag-1', folder: 'g1' } as never);
  vi.mocked(getMessagingGroup).mockResolvedValue({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C123',
  } as never);
  vi.mocked(envValue).mockReturnValue('xoxb-secret');
  call.mockResolvedValue({ ok: true, ts: '1700000000.000200' });
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
  it('posts to the session channel, records the ts and seeds state from initialState', async () => {
    await post();
    expect(call).toHaveBeenCalledTimes(1);
    const [token, method, body] = call.mock.calls[0];
    expect(token).toBe('xoxb-secret');
    expect(method).toBe('chat.postMessage');
    expect(body).toMatchObject({ channel: 'C123', text: 'Hi world' });
    expect(body).not.toHaveProperty('thread_ts');
    expect(JSON.stringify((body as any).blocks)).toContain('ncu:card-1:go');
    const row = await getCard('card-1');
    expect(row?.messageTs).toBe('1700000000.000200');
    expect(row?.state).toEqual({ pick: ['a'] });
    expect(row?.channelId).toBe('C123');
    expect(row?.instance).toBe('slack');
    expect(row?.ownerUserId).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('inserts the row before posting', async () => {
    let seen: unknown;
    call.mockImplementation(async () => {
      seen = await getCard('card-1');
      return { ok: true, ts: '1.2' };
    });
    await post();
    expect(seen).toMatchObject({ id: 'card-1', messageTs: null });
  });

  it('uses threadId when it names the same channel', async () => {
    await post({ threadId: 'slack:C123:1699999999.000100' });
    expect(call.mock.calls[0][2]).toMatchObject({ thread_ts: '1699999999.000100' });
    expect((await getCard('card-1'))?.threadTs).toBe('1699999999.000100');
  });

  it('ignores a threadId for another channel and falls back to session.thread_id', async () => {
    await post({ threadId: 'slack:C999:1.1' }, { ...session, thread_id: 'slack:C123:1698.5' });
    expect(call.mock.calls[0][2]).toMatchObject({ thread_ts: '1698.5' });
  });

  it('goes top-level when neither thread matches', async () => {
    await post({ threadId: 'bogus' }, { ...session, thread_id: 'slack:C999:1.1' });
    expect(call.mock.calls[0][2]).not.toHaveProperty('thread_ts');
    expect((await getCard('card-1'))?.threadTs).toBeNull();
  });

  it('uses the instance-specific token', async () => {
    vi.mocked(getMessagingGroup).mockResolvedValue({
      id: 'mg-1',
      channel_type: 'slack',
      platform_id: 'C123',
      instance: 'other',
    } as never);
    await post();
    expect(vi.mocked(envValue)).toHaveBeenCalledWith('SLACK_BOT_TOKEN_X');
    expect((await getCard('card-1'))?.instance).toBe('other');
  });

  describe('redelivery', () => {
    it('posts nothing, silently, when the same session already posted it', async () => {
      await post();
      call.mockClear();
      await post();
      expect(call).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('refuses a card id owned by another session', async () => {
      await post();
      call.mockClear();
      await post({}, { ...session, id: 'sess-2' });
      expect(call).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.anything(), 'post_card failed: card id already in use');
    });

    it('reposts when an earlier attempt left a row without a message ts', async () => {
      await insertCard({
        id: 'card-1',
        agentGroupId: 'ag-1',
        sessionId: 'sess-1',
        instance: 'slack',
        channelId: 'C123',
        threadTs: null,
        ownerUserId: null,
        templateName: 'demo-request',
        template: parseTemplate(templateJson, 'demo-request'),
        data: {},
        state: {},
      });
      await post();
      expect(call).toHaveBeenCalledTimes(1);
      const row = await getCard('card-1');
      expect(row?.messageTs).toBe('1700000000.000200');
      expect(row?.data).toEqual({ who: 'world', items: [{ name: 'a', selected: true }] });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('owner', () => {
    it('is the sender of the inReplyTo chat message, slack: prefix stripped', async () => {
      seedInbound([{ id: 'm1', kind: 'chat', content: JSON.stringify({ text: 'x', senderId: 'slack:U42' }) }]);
      await post({ inReplyTo: 'm1' });
      expect((await getCard('card-1'))?.ownerUserId).toBe('U42');
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
      expect((await getCard('card-1'))?.ownerUserId).toBe('U77');
    });

    it('skips a context row from someone else and takes the next triggering sender', async () => {
      seedInbound([chatRow('ctx', 'slack:UY', { trigger: 0 }), chatRow('trig', 'slack:UX')]);
      await post({ inReplyTo: 'ctx' });
      expect((await getCard('card-1'))?.ownerUserId).toBe('UX');
    });

    it('is the triggering row sender when inReplyTo is that row', async () => {
      seedInbound([chatRow('ctx', 'slack:UY', { trigger: 0 }), chatRow('trig', 'slack:UX')]);
      await post({ inReplyTo: 'trig' });
      expect((await getCard('card-1'))?.ownerUserId).toBe('UX');
    });

    it('is null when no triggering row follows a context row', async () => {
      seedInbound([chatRow('old', 'slack:UX'), chatRow('ctx', 'slack:UY', { trigger: 0 })]);
      await post({ inReplyTo: 'ctx' });
      expect((await getCard('card-1'))?.ownerUserId).toBeNull();
    });

    it('is null without inReplyTo', async () => {
      await post();
      expect((await getCard('card-1'))?.ownerUserId).toBeNull();
    });
  });

  describe('errors become a notice and nothing is posted', () => {
    const failed = (re: RegExp) => {
      expect(call).not.toHaveBeenCalled();
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
      expect(await getCard('card-1')).toBeUndefined();
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

  it('a Slack error deletes the row and notifies the agent', async () => {
    const { SlackApiError } =
      await vi.importActual<typeof import('../../channels/slack-lib.js')>('../../channels/slack-lib.js');
    call.mockRejectedValue(new SlackApiError('post_card', 'slack chat.postMessage failed: channel_not_found'));
    await post();
    expect(await getCard('card-1')).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      'post_card failed: slack chat.postMessage failed: channel_not_found',
    );
  });

  it('keeps the row and does not notify when saving the ts fails once', async () => {
    const save = vi.mocked(setMessageTs);
    save.mockRejectedValueOnce(new Error('db busy'));
    await post();
    expect(save).toHaveBeenCalledTimes(2);
    expect((await getCard('card-1'))?.messageTs).toBe('1700000000.000200');
    expect(notify).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cardId: 'card-1', ts: '1700000000.000200' }),
    );
  });

  it('keeps the row and does not notify when saving the ts fails twice', async () => {
    vi.mocked(setMessageTs).mockRejectedValueOnce(new Error('db gone')).mockRejectedValueOnce(new Error('db gone'));
    await post();
    expect(await getCard('card-1')).toBeDefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('an unexpected error is hidden behind a generic notice and never thrown', async () => {
    call.mockRejectedValue(new Error('secret xoxb-secret leaked'));
    await expect(post()).resolves.toBeUndefined();
    expect(await getCard('card-1')).toBeUndefined();
    expect(notify.mock.calls[0][1]).toBe('post_card failed: unexpected error (see host log)');
  });

  it('does not throw when notifyAgent itself fails', async () => {
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
});
