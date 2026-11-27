import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { getInboundDb, getOutboundDb, closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { getPendingMessages } from '../db/messages-in.js';
import { isMessageClaimed, releaseMessage } from '../message-claims.js';
import { ask, askSettings, parseAskInput } from './ask.js';
import { createMcpServer, registerTools } from './server.js';

beforeEach(() => {
  initTestSessionDb();
  askSettings.pollMs = 5;
  askSettings.timeoutScale = 1;
});
afterEach(() => {
  closeSessionDb();
  askSettings.pollMs = 1000;
  askSettings.timeoutScale = 1;
});

const q = (over: Record<string, unknown> = {}) => ({
  question: 'Which one?',
  options: [{ label: 'A' }, { label: 'B', description: 'second' }],
  ...over,
});

function insertAnswer(questionId: string, payload: Record<string, unknown>) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'webhook', datetime('now'), 'pending', 1, ?)`,
    )
    .run(
      `ask-${questionId}`,
      JSON.stringify({ source: 'slack-ui', event: 'ask_answer', payload: { questionId, ...payload } }),
    );
}

async function waitForQuestionId(): Promise<string> {
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  return JSON.parse(getUndeliveredMessages()[0].content).questionId;
}

describe('ask input', () => {
  it('accepts a minimal question and applies defaults', () => {
    const input = parseAskInput({ questions: [q()] });
    expect(input.timeout).toBe(300);
    expect(input.questions[0].multiSelect).toBe(false);
    expect(input.questions[0].allowOther).toBe(false);
    expect(input.who).toBeUndefined();
  });

  it('rejects bad input with a clear error', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{}, 'questions must be an array'],
      [{ questions: [] }, 'questions must have 1 to 4'],
      [{ questions: [q(), q(), q(), q(), q()] }, 'questions must have 1 to 4'],
      [{ questions: [q({ question: '' })] }, 'must not be empty'],
      [{ questions: [q({ question: 'x'.repeat(501) })] }, 'at most 500'],
      [{ questions: [q({ header: 'h'.repeat(61) })] }, 'at most 60'],
      [{ questions: [q({ options: [{ label: 'only' }] })] }, 'options must have 2 to 10'],
      [
        { questions: [q({ options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })) })] },
        'options must have 2 to 10',
      ],
      [{ questions: [q({ options: [{ label: 'a' }, { label: 'x'.repeat(76) }] })] }, 'at most 75'],
      [{ questions: [q({ options: [{ label: 'a' }, { label: 'b', description: 'd'.repeat(76) }] })] }, 'at most 75'],
      [{ questions: [q({ options: ['a', 'b'] })] }, 'must be an object'],
      [{ questions: [q({ multiSelect: 'yes' })] }, 'true or false'],
      [{ questions: [q()], who: { users: ['U1234567'], group: 'S1234567' } }, 'not both'],
      [{ questions: [q()], who: { users: [] } }, 'who.users'],
      [{ questions: [q()], who: { users: ['bob'] } }, 'who.users'],
      [{ questions: [q()], who: { users: Array(21).fill('U1234567') } }, 'who.users'],
      [{ questions: [q()], who: { group: 'nope' } }, 'who.group'],
      [{ questions: [q()], timeout: 10 }, 'timeout'],
      [{ questions: [q()], timeout: 301 }, 'timeout'],
    ];
    for (const [args, message] of bad) expect(() => parseAskInput(args)).toThrow(message);
  });

  it('the tool refuses bad input at once and writes nothing', async () => {
    const result = await ask.handler({ questions: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('questions must have 1 to 4');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('ask wait', () => {
  it('claims the answer before writing the action row, then returns the answer and leaves the claim to expire', async () => {
    const waiting = ask.handler({ questions: [q(), q({ question: 'Pick', multiSelect: true, allowOther: true })] });
    const questionId = await waitForQuestionId();
    expect(isMessageClaimed(`ask-${questionId}`)).toBe(true);
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.action).toBe('ask');
    expect(content.questions).toHaveLength(2);
    expect(content.who).toBeNull();
    expect('threadId' in content).toBe(true);
    expect('inReplyTo' in content).toBe(true);

    insertAnswer(questionId, {
      user: { id: 'U1234567', name: 'ann' },
      answers: [
        { question: 'Which one?', selected: ['A'] },
        { question: 'Pick', selected: ['A', 'B'], other: 'more' },
      ],
    });
    // the poll loop must not see the claimed answer
    expect(getPendingMessages().filter((m) => m.id === `ask-${questionId}`)).toHaveLength(1);
    const result = await waiting;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe('Answered by <@U1234567>:\n1. Which one?: A\n2. Pick: A, B; other: "more"');
    expect(isMessageClaimed(`ask-${questionId}`)).toBe(true);
    releaseMessage(`ask-${questionId}`);
    const ack = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get(`ask-${questionId}`) as { status: string } | undefined;
    expect(ack?.status).toBe('completed');
  });

  it('says (no choice) when only other text was given', async () => {
    const waiting = ask.handler({ questions: [q({ allowOther: true })] });
    const questionId = await waitForQuestionId();
    insertAnswer(questionId, {
      user: { id: 'U1234567', name: 'ann' },
      answers: [{ question: 'Which one?', selected: [], other: 'neither' }],
    });
    expect((await waiting).content[0].text).toBe(
      'Answered by <@U1234567>:\n1. Which one?: (no choice); other: "neither"',
    );
  });

  it('returns an error for a failed row', async () => {
    const waiting = ask.handler({ questions: [q()] });
    const questionId = await waitForQuestionId();
    insertAnswer(questionId, { failed: 'not a Slack chat' });
    const result = await waiting;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Slack chat');
    releaseMessage(`ask-${questionId}`);
  });

  it('on timeout releases the claim and reports no answer without an error flag', async () => {
    askSettings.timeoutScale = 0.0002; // 30 s -> 6 ms
    const waiting = ask.handler({ questions: [q()], timeout: 30 });
    const questionId = await waitForQuestionId();
    const result = await waiting;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe(
      'No answer after 30s. The card stays open; if someone answers later, the answer arrives as a new message.',
    );
    expect(isMessageClaimed(`ask-${questionId}`)).toBe(false);
  });

  it('on abort stops promptly and releases the claim', async () => {
    const controller = new AbortController();
    const waiting = ask.handler({ questions: [q()] }, { signal: controller.signal });
    const questionId = await waitForQuestionId();
    controller.abort();
    const result = await waiting;
    expect(result.content[0].text).toContain('cancelled');
    expect(isMessageClaimed(`ask-${questionId}`)).toBe(false);
  });
});

describe('ask ends early', () => {
  const THREAD = 'slack:C1:111.000';
  let seq = 100;

  function setRouting() {
    getInboundDb().exec(
      'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT)',
    );
    getInboundDb()
      .prepare(
        "INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'slack:C1', NULL)",
      )
      .run();
  }

  function insertChat(id: string, threadId: string | null, trigger = 1, sender = 'Gokul') {
    seq += 2;
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, 'slack:C1', 'slack', ?, ?)`,
      )
      .run(id, seq, trigger, threadId, JSON.stringify({ sender, text: 'hi' }));
  }

  function closeRequests(): string[] {
    return getUndeliveredMessages()
      .map((m) => JSON.parse(m.content))
      .filter((c) => c.action === 'ask_close')
      .map((c) => c.questionId);
  }

  it('a chat message in the card thread ends the wait and asks the host to close the card', async () => {
    setRouting();
    insertChat('m-before', THREAD); // the message being answered: not a reply to the card
    const waiting = ask.handler({ questions: [q()] });
    const questionId = await waitForQuestionId();
    expect(JSON.parse(getUndeliveredMessages()[0].content).threadId).toBe(THREAD);
    insertChat('m-reply', THREAD);
    const result = await waiting;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Gokul replied in the thread instead of answering');
    expect(closeRequests()).toEqual([questionId]);
    expect(isMessageClaimed(`ask-${questionId}`)).toBe(false);
    // the reply itself is left for the poll loop
    expect(getPendingMessages().some((m) => m.id === 'm-reply')).toBe(true);
  });

  it('ignores messages in another thread and messages not addressed to the agent', async () => {
    setRouting();
    insertChat('m-before', THREAD);
    askSettings.timeoutScale = 0.002; // 30 s -> 60 ms
    const waiting = ask.handler({ questions: [q()], timeout: 30 });
    const questionId = await waitForQuestionId();
    insertChat('m-other-thread', 'slack:C1:999.000');
    await Bun.sleep(15);
    insertChat('m-ambient', THREAD, 0);
    const result = await waiting;
    expect(result.content[0].text).toContain('No answer after 30s');
    expect(closeRequests()).toEqual([]);
    expect(isMessageClaimed(`ask-${questionId}`)).toBe(false);
  });

  it('returns a cancel without an error flag', async () => {
    const waiting = ask.handler({ questions: [q()] });
    const questionId = await waitForQuestionId();
    insertAnswer(questionId, { user: { id: 'U1234567', name: 'ann' }, cancelled: true });
    const result = await waiting;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('<@U1234567> cancelled the question without answering');
    releaseMessage(`ask-${questionId}`);
  });
});

describe('ask and ask_user_question visibility', () => {
  async function listed(channelType: string | null): Promise<string[]> {
    getInboundDb().exec(
      'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT)',
    );
    getInboundDb()
      .prepare(
        "INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, 'C1', NULL)",
      )
      .run(channelType);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'fixture', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('shows ask and hides ask_user_question in Slack, and the reverse elsewhere', async () => {
    registerTools([
      {
        tool: { name: 'ask_user_question', inputSchema: { type: 'object', properties: {} } },
        handler: async () => ({ content: [] }),
      },
    ]); // duplicate registration is skipped when the real tool is loaded
    const slack = await listed('slack');
    expect(slack).toContain('ask');
    expect(slack).not.toContain('ask_user_question');
    const other = await listed('discord');
    expect(other).not.toContain('ask');
    expect(other).toContain('ask_user_question');
  });
});
