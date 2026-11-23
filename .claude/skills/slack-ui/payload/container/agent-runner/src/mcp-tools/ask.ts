/**
 * ask MCP tool: ask the people in a Slack chat one to four questions on a card
 * and wait for the answer.
 *
 * The tool writes a system action row, the host posts the card, and the answer
 * comes back as a normal inbound message (`source: slack-ui`, `event:
 * ask_answer`, id `ask-<questionId>`). While the tool waits it claims that
 * message (message-claims.ts) so the poll loop does not hand it to the agent as
 * well; after a timeout the claim is released and a late answer arrives as an
 * ordinary message.
 *
 * In a Slack chat `ask_user_question` is hidden and this tool is shown; in any
 * other chat the reverse.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { getMessageIn, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, resolveDestinationThread } from '../db/session-routing.js';
import { getCurrentInReplyTo, getCurrentReplyRoute } from '../db/session-state.js';
import { claimMessage, releaseMessage } from '../message-claims.js';
import { hideTool, registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const LIMITS = {
  questions: [1, 4],
  question: 500,
  header: 60,
  options: [2, 10],
  label: 75,
  description: 75,
  users: 20,
  timeout: [30, 300],
} as const;

const DEFAULT_TIMEOUT_SECONDS = 300;
const USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const GROUP_ID_RE = /^S[A-Z0-9]{2,}$/;

/** Mutable only so tests need not wait whole seconds. */
export const askSettings = { pollMs: 1000, timeoutScale: 1 };

export type AskOption = { label: string; description?: string };
export type AskQuestion = {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
  allowOther: boolean;
};
export type AskWho = { users?: string[]; group?: string };
export type AskInput = { questions: AskQuestion[]; who?: AskWho; timeout: number };

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, where: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new Error(`${where} must be a string`);
  if (v.trim().length < min) throw new Error(`${where} must not be empty`);
  if (v.length > max) throw new Error(`${where} must be at most ${max} characters`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw new Error(`${where} must be true or false`);
  return v;
}

/** Throws an Error with a clear message on the first problem. */
export function parseAskInput(args: Record<string, unknown>): AskInput {
  const rawQuestions = args.questions;
  if (!Array.isArray(rawQuestions)) throw new Error('questions must be an array');
  const [qMin, qMax] = LIMITS.questions;
  if (rawQuestions.length < qMin || rawQuestions.length > qMax) {
    throw new Error(`questions must have ${qMin} to ${qMax} entries`);
  }
  const questions = rawQuestions.map((rawQ, i): AskQuestion => {
    const at = `questions[${i}]`;
    if (!isObj(rawQ)) throw new Error(`${at} must be an object`);
    const question = text(rawQ.question, `${at}.question`, 1, LIMITS.question);
    const header = rawQ.header === undefined ? undefined : text(rawQ.header, `${at}.header`, 1, LIMITS.header);
    const rawOptions = rawQ.options;
    const [oMin, oMax] = LIMITS.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < oMin || rawOptions.length > oMax) {
      throw new Error(`${at}.options must have ${oMin} to ${oMax} entries`);
    }
    const options = rawOptions.map((rawO, j): AskOption => {
      const where = `${at}.options[${j}]`;
      if (!isObj(rawO)) throw new Error(`${where} must be an object with a label`);
      const label = text(rawO.label, `${where}.label`, 1, LIMITS.label);
      const description =
        rawO.description === undefined
          ? undefined
          : text(rawO.description, `${where}.description`, 0, LIMITS.description);
      return description ? { label, description } : { label };
    });
    return {
      question,
      ...(header ? { header } : {}),
      options,
      multiSelect: bool(rawQ.multiSelect, `${at}.multiSelect`),
      allowOther: bool(rawQ.allowOther, `${at}.allowOther`),
    };
  });

  let who: AskWho | undefined;
  if (args.who !== undefined) {
    if (!isObj(args.who)) throw new Error('who must be an object');
    const { users, group } = args.who;
    if (users !== undefined && group !== undefined) throw new Error('who takes users or group, not both');
    if (users !== undefined) {
      if (!Array.isArray(users) || users.length === 0 || users.length > LIMITS.users) {
        throw new Error(`who.users must have 1 to ${LIMITS.users} Slack user ids`);
      }
      if (!users.every((u) => typeof u === 'string' && USER_ID_RE.test(u))) {
        throw new Error('who.users must be Slack user ids such as U0123ABCD');
      }
      who = { users: users as string[] };
    } else if (group !== undefined) {
      if (typeof group !== 'string' || !GROUP_ID_RE.test(group)) {
        throw new Error('who.group must be a Slack user group id such as S0123ABCD');
      }
      who = { group };
    }
  }

  let timeout = DEFAULT_TIMEOUT_SECONDS;
  if (args.timeout !== undefined) {
    const [tMin, tMax] = LIMITS.timeout;
    if (
      typeof args.timeout !== 'number' ||
      !Number.isFinite(args.timeout) ||
      args.timeout < tMin ||
      args.timeout > tMax
    ) {
      throw new Error(`timeout must be a number of seconds from ${tMin} to ${tMax}`);
    }
    timeout = args.timeout;
  }
  return { questions, ...(who ? { who } : {}), timeout };
}

/** Same threading as post_card: the bound thread is the last resort. */
function routing() {
  const session = getSessionRouting();
  const thread =
    session.channel_type && session.platform_id
      ? resolveDestinationThread(session.channel_type, session.platform_id, getCurrentReplyRoute())
      : null;
  return { ...session, thread_id: thread?.threadId ?? session.thread_id };
}

function isSlack(): boolean {
  try {
    return getSessionRouting().channel_type === 'slack';
  } catch {
    return false;
  }
}

type Answer = { question?: unknown; selected?: unknown; other?: unknown };

function answerText(payload: Record<string, unknown>): string {
  const user = isObj(payload.user) && typeof payload.user.id === 'string' ? payload.user.id : 'unknown';
  const answers = Array.isArray(payload.answers) ? (payload.answers as Answer[]) : [];
  const lines = answers.map((a, i) => {
    const selected = Array.isArray(a.selected) ? a.selected.filter((s): s is string => typeof s === 'string') : [];
    let line = `${i + 1}. ${String(a.question ?? '')}: ${selected.length > 0 ? selected.join(', ') : '(no choice)'}`;
    if (typeof a.other === 'string' && a.other !== '') line += `; other: ${JSON.stringify(a.other)}`;
    return line;
  });
  return [`Answered by <@${user}>:`, ...lines].join('\n');
}

export const ask: McpToolDefinition = {
  tool: {
    name: 'ask',
    description:
      'Ask the people in this Slack chat one to four multiple-choice questions on a card and wait for the answer. Blocking: execution pauses until someone answers or the timeout passes. Use it instead of ask_user_question in Slack.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: 'One to four questions shown on one card.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', maxLength: 500 },
              header: { type: 'string', maxLength: 60, description: 'Short bold title above the question.' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 10,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', maxLength: 75 },
                    description: { type: 'string', maxLength: 75, description: 'Shown under the label.' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow more than one choice. Default false.' },
              allowOther: {
                type: 'boolean',
                description: 'Add a text box for an answer not in the list. Default false.',
              },
            },
            required: ['question', 'options'],
          },
        },
        who: {
          type: 'object',
          description:
            'Who may answer besides the person you are talking to: users (Slack user ids, up to 20) or group (a Slack user group id), not both. Default: only the asker.',
          properties: {
            users: { type: 'array', maxItems: 20, items: { type: 'string' } },
            group: { type: 'string' },
          },
        },
        timeout: { type: 'number', minimum: 30, maximum: 300, description: 'Seconds to wait (default 300).' },
      },
      required: ['questions'],
    },
  },
  async handler(args, context) {
    if (context?.signal.aborted) return err('Question cancelled');
    let input: AskInput;
    try {
      input = parseAskInput(args);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }

    const questionId = randomUUID();
    const messageId = `ask-${questionId}`;
    // Claim before the card exists, so the answer can never reach the agent first.
    claimMessage(messageId);
    try {
      await writeMessageOut({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'system',
        content: JSON.stringify({
          action: 'ask',
          questionId,
          questions: input.questions,
          who: input.who ?? null,
          threadId: routing().thread_id,
          inReplyTo: getCurrentInReplyTo(),
        }),
      });
      log(`ask: ${questionId} (${input.questions.length} question(s))`);

      const deadline = Date.now() + input.timeout * 1000 * askSettings.timeoutScale;
      while (Date.now() < deadline) {
        if (context?.signal.aborted) return err('Question cancelled');
        const row = getMessageIn(messageId);
        if (row) {
          markCompleted([row.id]);
          let payload: Record<string, unknown> = {};
          try {
            const content = JSON.parse(row.content) as { payload?: unknown };
            if (isObj(content.payload)) payload = content.payload;
          } catch {
            // fall through: an unreadable answer is reported below
          }
          if (typeof payload.failed === 'string')
            return err(`The question card could not be posted: ${payload.failed}`);
          if (!Array.isArray(payload.answers)) return err('The answer could not be read.');
          return ok(answerText(payload));
        }
        await sleep(askSettings.pollMs);
      }
      return ok(
        `No answer after ${input.timeout}s. The card stays open; if someone answers later, the answer arrives as a new message.`,
      );
    } finally {
      releaseMessage(messageId);
    }
  },
};

registerTools([ask]);
hideTool('ask_user_question', isSlack);
hideTool('ask', () => !isSlack());
