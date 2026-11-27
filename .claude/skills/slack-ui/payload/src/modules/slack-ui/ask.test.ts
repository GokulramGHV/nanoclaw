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
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn(), getMessagingGroupsByAgentGroup: vi.fn() }));
vi.mock('../../group-folder.js', () => ({ resolveGroupFolderPath: vi.fn() }));
vi.mock('../../session-manager.js', () => ({ sessionDir: vi.fn(), writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: any }>,
  postError: undefined as unknown,
  updateError: undefined as unknown,
  n: 0,
}));
vi.mock('./slack-client.js', () => ({
  slackClientForToken: () => ({
    chat: {
      postMessage: async (args: unknown) => {
        fake.calls.push({ method: 'chat.postMessage', args });
        if (fake.postError) throw fake.postError;
        return { ok: true, ts: `1700000000.${String(200 + fake.n++).padStart(6, '0')}` };
      },
      update: async (args: unknown) => {
        fake.calls.push({ method: 'chat.update', args });
        if (fake.updateError) throw fake.updateError;
        return { ok: true };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    views: { open: async () => ({ ok: true }) },
  }),
  slackClientForInstance: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { envValue } from '../../env.js';
import { getDeliveryAction } from '../../delivery.js';
import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { requestWake } from '../../request-wake.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import { askAccess, buildAskCard, handleAsk, handleAskClose, parseAskSpec, writeAskAnswer, type AskSpecQuestion } from './ask.js';
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
  fake.updateError = undefined;
  fake.n = 0;
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
    expect(getDeliveryAction('ask_close')).toBe(handleAskClose);
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
    const lock = { ids: ['send'] };
    expect(askAccess(undefined, 'U1')).toEqual({ default: 'owner', lock });
    expect(askAccess({ users: ['U2', 'U1'] }, 'U1')).toEqual({ default: { users: ['U1', 'U2'] }, lock });
    expect(askAccess({ users: ['U2'] }, '')).toEqual({ default: { users: ['U2'] }, lock });
    expect(askAccess({ group: 'S1234567' }, 'U1')).toEqual({ default: { group: 'S1234567' }, lock });
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

describe('closing an older ask', () => {
  const twoMessages = () => {
    fs.rmSync(path.join(sessDir, 'inbound.db'));
    seedInbound([
      { id: 'm-1', seq: 2, kind: 'chat', content: { text: 'hi', senderId: 'slack:U9' } },
      { id: 'm-2', seq: 4, kind: 'chat', content: { text: 'again', senderId: 'slack:U9' } },
    ]);
  };
  const closedAt = async (id: string) => (await getCardById(id))?.locked;
  const updates = () => fake.calls.filter((c) => c.method === 'chat.update');

  it('stores the message the ask replies to', async () => {
    await handleAsk(content(), session);
    expect((await getCardById('q-1'))?.meta?.inReplyTo).toBe('m-1');
  });

  it('closes an older open ask for the same message, without an event, then posts the new one', async () => {
    await handleAsk(content({ questionId: 'q-1' }), session);
    await handleAsk(content({ questionId: 'q-2' }), session);
    expect(posts()).toHaveLength(2);
    expect(await closedAt('q-1')).toMatchObject({ note: 'Replaced by a newer question.' });
    expect(await closedAt('q-2')).toBeUndefined();
    expect(JSON.stringify(updates()[0]!.args.blocks)).toContain('Replaced by a newer question.');
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves locked asks and asks for other messages alone', async () => {
    twoMessages();
    await handleAsk(content({ questionId: 'q-a' }), session);
    await handleAsk(content({ questionId: 'q-b', inReplyTo: 'm-2' }), session);
    await handleAsk(content({ questionId: 'q-c' }), session); // closes q-a
    expect(await closedAt('q-a')).toBeDefined();
    expect(await closedAt('q-b')).toBeUndefined();
    const lockedBefore = await getCardById('q-a');
    fake.calls.length = 0;
    await handleAsk(content({ questionId: 'q-d' }), session); // closes q-c only; q-a already locked
    expect(updates()).toHaveLength(1);
    expect(await getCardById('q-a')).toEqual(lockedBefore);
    expect(await closedAt('q-b')).toBeUndefined();
    expect(await closedAt('q-c')).toBeDefined();
  });

  it('leaves the old ask open when the new post fails', async () => {
    await handleAsk(content({ questionId: 'q-1' }), session);
    fake.postError = new Error('slack down');
    await handleAsk(content({ questionId: 'q-2' }), session);
    expect(await closedAt('q-1')).toBeUndefined();
    expect(updates()).toHaveLength(0);
  });

  it('still posts the new card when closing fails', async () => {
    await handleAsk(content({ questionId: 'q-1' }), session);
    fake.updateError = new Error('slack down');
    await handleAsk(content({ questionId: 'q-2' }), session);
    expect(posts()).toHaveLength(2);
    expect(await getCardById('q-2')).toBeDefined();
    expect(write).not.toHaveBeenCalled();
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

  it('decodes entities in the typed text, leaving plain text alone', async () => {
    await writeAskAnswer(askEvent({ state: { $q0: '', $q0_other: 'R&amp;D &lt;b&gt;', $q1: [] } }));
    expect(rowOf().payload.answers[0].other).toBe('R&D <b>');
    write.mockClear();
    await writeAskAnswer(askEvent({ state: { $q0: '', $q0_other: 'plain text', $q1: [] } }));
    expect(rowOf().payload.answers[0].other).toBe('plain text');
  });

  it('ignores a duplicate id', async () => {
    write.mockRejectedValueOnce(
      Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }),
    );
    await expect(writeAskAnswer(askEvent())).resolves.toBeUndefined();
    expect(requestWake).not.toHaveBeenCalled();
  });
});

describe('ask from a scheduled task run', () => {
  const taskSession = { ...session, id: 'sess-task', messaging_group_id: null, thread_id: 'system:tasks:t-1' };

  function seedTask(originRoute: object | null): void {
    const db = new Database(path.join(sessDir, 'inbound.db'));
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, \"trigger\", content, series_id, status) VALUES ('t-1', 4, 'task', '2026-01-01T00:00:00.000Z', 1, ?, 't-1', 'pending')",
    ).run(JSON.stringify({ prompt: 'p', script: null, originSessionId: null, ...(originRoute ? { originRoute } : {}) }));
    db.close();
  }

  it('asks in the thread the task was created from when that chat is wired', async () => {
    seedTask({ channelType: 'slack', platformId: 'slack:C999', threadId: 'slack:C999:1699.5' });
    vi.mocked(getMessagingGroupsByAgentGroup).mockResolvedValue([
      { id: 'mg-9', channel_type: 'slack', platform_id: 'slack:C999', instance: 'slack' },
    ] as never);
    await handleAsk(content({ who: { users: ['U2345678'] } }), taskSession as never);
    expect(posts()[0]!.args).toMatchObject({ channel: 'C999', thread_ts: '1699.5' });
  });

  it('refuses a task with no route', async () => {
    seedTask(null);
    await handleAsk(content({ who: { users: ['U2345678'] } }), taskSession as never);
    expect(posts()).toHaveLength(0);
  });
});

describe('cancel and close', () => {
  const POSTED_TS = '1700000000.000200';
  const click = (user: string, actionId: string) => ({
    type: 'block_actions',
    user: { id: user, name: 'ann' },
    channel: { id: 'C123' },
    message: { ts: POSTED_TS },
    trigger_id: 't',
    actions: [{ action_id: actionId, type: 'button', block_id: 'b', value: '' }],
  });
  const client = () => ({
    chat: {
      update: async (args: unknown) => {
        fake.calls.push({ method: 'chat.update', args });
        return { ok: true };
      },
      postEphemeral: async (args: unknown) => {
        fake.calls.push({ method: 'chat.postEphemeral', args });
        return { ok: true };
      },
    },
  });
  const press = async (user: string, actionId: string) => {
    const r: any = await kit.handleAction(client() as never, click(user, actionId));
    await r?.done;
  };

  it('the card has a Cancel button next to Send', async () => {
    const { source, state } = buildAskCard([question()]);
    const rendered = JSON.stringify(await kit.render(source, state));
    expect(rendered).toContain('"action_id":"send"');
    expect(rendered).toContain('"action_id":"cancel"');
  });

  it('Cancel with nothing picked closes the card and tells the agent once', async () => {
    await handleAsk(content(), session);
    expect((await getCardById('q-1'))?.ts).toBe(POSTED_TS);
    noteEventContext('C123', POSTED_TS, 'U9', { actionTs: '5.5', userName: 'ann' });
    await press('U9', 'cancel');
    expect((await getCardById('q-1'))?.locked).toMatchObject({ note: 'Cancelled by ann.' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(rowOf().payload).toEqual({ questionId: 'q-1', user: { id: 'U9', name: 'ann' }, cancelled: true });
    expect(requestWake).toHaveBeenCalledTimes(1);
    await press('U9', 'cancel'); // a locked card refuses the second press
    await press('U9', 'send');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('Send with nothing picked is still refused', async () => {
    await handleAsk(content(), session);
    await press('U9', 'send');
    expect((await getCardById('q-1'))?.locked).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('only someone allowed to answer can cancel', async () => {
    await handleAsk(content(), session);
    await press('U7', 'cancel');
    expect((await getCardById('q-1'))?.locked).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('ask_close closes only an open card from the same session, without an answer', async () => {
    await handleAsk(content(), session);
    await handleAskClose({ questionId: 'q-1' }, { ...session, id: 'sess-other' });
    expect((await getCardById('q-1'))?.locked).toBeUndefined();
    await handleAskClose({ questionId: 'q-1' }, session);
    expect((await getCardById('q-1'))?.locked).toMatchObject({ note: 'Answered in the thread.' });
    expect(write).not.toHaveBeenCalled();
    await expect(handleAskClose({ questionId: 'missing' }, session)).resolves.toBeUndefined();
    await expect(handleAskClose({ questionId: '../x' }, session)).resolves.toBeUndefined();
  });
});
