import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import type { CardEvent } from 'slack-ui-kit';
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
}));
vi.mock('./slack-client.js', () => ({
  slackClientForToken: () => ({
    chat: {
      postMessage: async (args: unknown) => {
        fake.calls.push({ method: 'chat.postMessage', args });
        if (fake.postError) throw fake.postError;
        return { ok: true, ts: '1700000000.000200' };
      },
      update: async (args: unknown) => (fake.calls.push({ method: 'chat.update', args }), { ok: true }),
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    views: { open: async () => ({ ok: true }) },
  }),
  slackClientForInstance: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { envValue } from '../../env.js';
import { getDeliveryAction } from '../../delivery.js';
import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { requestWake } from '../../request-wake.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import { askAccess, buildAskCard, handleAsk, parseAskSpec, writeAskAnswer, type AskSpecQuestion } from './ask.js';
import './index.js';
import { noteEventContext } from './events.js';
import { kit, routeCardEvent } from './kit.js';

const write = vi.mocked(writeSessionMessage);

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
let sessDir: string;

const question = (over: Partial<AskSpecQuestion> = {}): AskSpecQuestion => ({
  question: 'Which env?',
  options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
  multiSelect: false,
  allowOther: false,
  ...over,
});

const content = (over: Record<string, unknown> = {}) => ({
  action: 'ask',
  questionId: 'q-1',
  questions: [question()],
  who: null,
  threadId: null,
  inReplyTo: 'm-1',
  ...over,
});

const posts = () => fake.calls.filter((c) => c.method === 'chat.postMessage');
const rowOf = (n = 0) => JSON.parse(write.mock.calls[n]![2].content);

function seedInbound(
  rows: Array<{ id: string; seq: number; kind: string; content: object }> = [
    { id: 'm-1', seq: 2, kind: 'chat', content: { text: 'hi', senderId: 'slack:U9' } },
  ],
): void {
  const db = new Database(path.join(sessDir, 'inbound.db'));
  db.exec(INBOUND_SCHEMA);
  const insert = db.prepare(
    'INSERT INTO messages_in (id, seq, kind, timestamp, "trigger", content) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) insert.run(r.id, r.seq, r.kind, '2026-01-01T00:00:00.000Z', 1, JSON.stringify(r.content));
  db.close();
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.postError = undefined;
  sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ui-ask-'));
  dirs.push(sessDir);
  vi.mocked(sessionDir).mockReturnValue(sessDir);
  vi.mocked(getMessagingGroup).mockResolvedValue({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C123',
  } as never);
  vi.mocked(getSession).mockResolvedValue(session as never);
  vi.mocked(envValue).mockReturnValue('xoxb-secret');
  seedInbound();
});

afterEach(async () => {
  await closeDb();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('registration', () => {
  it('registers ask as a delivery action', () => {
    expect(getDeliveryAction('ask')).toBe(handleAsk);
  });
});

describe('parseAskSpec', () => {
  it('accepts a good spec and refuses bad ones', () => {
    expect(parseAskSpec(content()).questions).toHaveLength(1);
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ questions: [] }, 'questions must have'],
      [{ questions: [question({ question: '' })] }, 'must not be empty'],
      [{ questions: [question({ options: [{ label: 'one' }] })] }, 'options must have'],
      [{ questions: [question({ question: 'x'.repeat(501) })] }, 'too long'],
      [{ who: { users: ['U1234567'], group: 'S1234567' } }, 'not both'],
      [{ who: { users: ['nope'] } }, 'Slack user ids'],
      [{ who: { group: 'nope' } }, 'user group id'],
    ];
    for (const [over, msg] of bad) expect(() => parseAskSpec(content(over))).toThrow(msg);
  });
});

describe('buildAskCard', () => {
  it('renders radio options with values 0, 1, descriptions, and a locking Send button', async () => {
    const { source, state } = buildAskCard([question()]);
    const out = await kit.render(source, state);
    const json = JSON.stringify(out.blocks);
    expect(json).toContain('radio_buttons');
    expect(json).toContain('"value":"0"');
    expect(json).toContain('"value":"1"');
    expect(json).toContain('Staging');
    expect(json).toContain('safe');
    expect(json).toContain('Which env?');
    expect(json).toContain('Send');
    expect(json).not.toContain('plain_text_input');
    expect(Object.values(out.controls)).toContain('button');
  });

  it('renders checkboxes for multiSelect and a text box only with allowOther', async () => {
    const multi = buildAskCard([question({ multiSelect: true, allowOther: true }), question({ question: 'Second?' })]);
    const out = await kit.render(multi.source, multi.state);
    const json = JSON.stringify(out.blocks);
    expect(json).toContain('checkboxes');
    expect(json).toContain('radio_buttons');
    expect(json.match(/plain_text_input/g)).toHaveLength(1);
    expect(json).toContain('Or type your own answer');
    expect(json).toContain('Second?');
  });

  it('keeps agent text out of the source; question and header are escaped, option text is not (plain_text)', async () => {
    const evil = question({
      question: 'a & <b> "q" ) ]',
      header: 'H <x>',
      options: [{ label: 'x") + Evil("', description: '<d>' }, { label: 'ok' }],
    });
    const { source, state } = buildAskCard([evil]);
    expect(source).not.toContain('Evil');
    expect(source).not.toContain('a &');
    expect(source).not.toContain('<b>');
    expect(state.q0_text).toBe('*H &lt;x&gt;*\na &amp; &lt;b&gt; "q" ) ]');
    expect(state.q0_opts).toEqual([
      { v: '0', l: 'x") + Evil("', d: '<d>' },
      { v: '1', l: 'ok', d: '' },
    ]);
    const out = await kit.render(source, state);
    expect(JSON.stringify(out.blocks)).toContain('Evil');
  });

  it('requires one group per question, with the other box only when allowed', () => {
    expect(buildAskCard([question(), question({ allowOther: true })]).required).toEqual([['q0'], ['q1', 'q1_other']]);
  });
});

describe('askAccess', () => {
  it('maps who to rules', () => {
    expect(askAccess(undefined, 'U1')).toEqual({ default: 'owner' });
    expect(askAccess({ users: ['U2', 'U1'] }, 'U1')).toEqual({ default: { users: ['U1', 'U2'] } });
    expect(askAccess({ users: ['U2'] }, '')).toEqual({ default: { users: ['U2'] } });
    expect(askAccess({ group: 'S1234567' }, 'U1')).toEqual({ default: { group: 'S1234567' } });
  });
});

describe('ask delivery action', () => {
  it('posts the card, saves it with ask metadata and the asker as owner', async () => {
    await handleAsk(
      content({ inReplyTo: 'm-1', threadId: 'slack:C123:1699.1', who: { users: ['U2345678'] } }),
      session,
    );
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.args).toMatchObject({ channel: 'C123', thread_ts: '1699.1' });
    const card = await getCardById('q-1');
    expect(card).toMatchObject({
      owner: 'U9',
      trusted: true,
      access: { default: { users: ['U9', 'U2345678'] } },
      required: [['q0']],
      meta: { kind: 'ask', questionId: 'q-1', agentGroupId: 'ag-1', sessionId: 'sess-1', instance: 'slack' },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not post twice for a redelivered ask', async () => {
    await handleAsk(content(), session);
    await handleAsk(content(), session);
    expect(posts()).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes a failed row on each failure path', async () => {
    const cases: Array<[string, () => Promise<void> | void, string]> = [
      ['bad input', () => {}, 'questions must have'],
      [
        'not slack',
        () =>
          void vi.mocked(getMessagingGroup).mockResolvedValue({ channel_type: 'discord', platform_id: 'x' } as never),
        'Slack chat',
      ],
      ['no token', () => void vi.mocked(envValue).mockReturnValue(undefined as never), 'not configured'],
      [
        'slack error',
        () => {
          fake.postError = Object.assign(new Error('slack chat.postMessage failed: not_in_channel xoxb-leak'), {
            name: 'SlackApiError',
            data: { error: 'not_in_channel' },
          });
        },
        'Slack refused the card (not_in_channel)',
      ],
    ];
    for (const [i, [name, setup, reason]] of cases.entries()) {
      vi.clearAllMocks();
      vi.mocked(getMessagingGroup).mockResolvedValue({
        id: 'mg-1',
        channel_type: 'slack',
        platform_id: 'slack:C123',
      } as never);
      vi.mocked(envValue).mockReturnValue('xoxb-secret');
      fake.postError = undefined;
      await setup();
      const qid = `q-fail-${i}`;
      await handleAsk(content({ questionId: qid, ...(name === 'bad input' ? { questions: [] } : {}) }), session);
      expect(write, name).toHaveBeenCalledTimes(1);
      const msg = write.mock.calls[0]![2];
      expect(msg.id).toBe(`ask-${qid}`);
      expect(msg.kind).toBe('webhook');
      const row = JSON.parse(msg.content);
      expect(row.event).toBe('ask_answer');
      expect(row.payload.questionId).toBe(qid);
      expect(row.payload.failed, name).toContain(reason);
      expect(JSON.stringify(row)).not.toContain('xoxb');
    }
  });

  it('fails at once when there is no owner and no who, and posts nothing', async () => {
    await handleAsk(content({ inReplyTo: 'missing' }), session);
    expect(posts()).toHaveLength(0);
    expect(rowOf().payload.failed).toContain('no one to answer');
  });

  it('posts without an owner when who names someone', async () => {
    await handleAsk(content({ inReplyTo: 'missing', who: { group: 'S1234567' } }), session);
    expect(posts()).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('takes the owner from an ask_answer row the agent is replying to', async () => {
    fs.rmSync(path.join(sessDir, 'inbound.db'));
    seedInbound([
      {
        id: 'late-1',
        seq: 2,
        kind: 'webhook',
        content: {
          source: 'slack-ui',
          event: 'ask_answer',
          payload: { questionId: 'q-0', user: { id: 'U7', name: 'bo' }, answers: [] },
        },
      },
    ]);
    await handleAsk(content({ inReplyTo: 'late-1' }), session);
    expect((await getCardById('q-1'))?.owner).toBe('U7');
  });

  it('a session without a chat fails with a row too', async () => {
    await handleAsk(content(), { ...session, messaging_group_id: null });
    expect(rowOf().payload.failed).toContain('no chat');
  });
});

describe('ask answer', () => {
  const askEvent = (over: Partial<CardEvent> = {}): CardEvent => ({
    type: 'action',
    card: { channel: 'C123', ts: '1.1', threadTs: '1.0' },
    user: 'U9',
    control: { id: 'send', kind: 'button' },
    state: { $sent: true, $q0: '1', $q1: ['0', '2'], $q1_other: '  more  ' },
    locked: { by: 'U9', at: '2026-01-01T00:00:00.000Z', label: 'Send' },
    meta: {
      kind: 'ask',
      questionId: 'q-1',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      instance: 'slack',
      questions: [
        { question: 'Which env?', options: ['Staging', 'Prod'] },
        { question: 'Which tools?', options: ['a', 'b', 'c'] },
      ],
    },
    ...over,
  });

  it('writes one ask_answer row with labels, other text and the user name, then wakes', async () => {
    noteEventContext('C123', '1.1', 'U9', { actionTs: '5.5', userName: 'ann' });
    await routeCardEvent(askEvent());
    expect(write).toHaveBeenCalledTimes(1);
    const [group, sess, msg] = write.mock.calls[0]!;
    expect([group, sess]).toEqual(['ag-1', 'sess-1']);
    expect(msg).toMatchObject({
      id: 'ask-q-1',
      kind: 'webhook',
      platformId: 'slack:C123',
      channelType: 'slack',
      threadId: 'slack:C123:1.0',
      trigger: true,
    });
    expect(JSON.parse(msg.content)).toEqual({
      source: 'slack-ui',
      event: 'ask_answer',
      payload: {
        questionId: 'q-1',
        user: { id: 'U9', name: 'ann' },
        answers: [
          { question: 'Which env?', selected: ['Prod'] },
          { question: 'Which tools?', selected: ['a', 'c'], other: 'more' },
        ],
      },
    });
    expect(requestWake).toHaveBeenCalledWith(session, 'interactive');
  });

  it('writes nothing for an event that did not lock the card', async () => {
    await writeAskAnswer(askEvent({ locked: undefined }));
    expect(write).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('keeps an empty selection when only other text was given', async () => {
    await writeAskAnswer(askEvent({ state: { $q0: '', $q0_other: 'neither', $q1: [] } }));
    expect(rowOf().payload.answers[0]).toEqual({ question: 'Which env?', selected: [], other: 'neither' });
    expect(rowOf().payload.answers[1]).toEqual({ question: 'Which tools?', selected: [] });
  });

  it('ignores a duplicate id', async () => {
    write.mockRejectedValueOnce(
      Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }),
    );
    await expect(writeAskAnswer(askEvent())).resolves.toBeUndefined();
    expect(requestWake).not.toHaveBeenCalled();
  });
});
