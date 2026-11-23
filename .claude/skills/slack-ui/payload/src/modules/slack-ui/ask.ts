/**
 * `ask` delivery action: post a question card into the session's own Slack chat
 * and, when someone presses Send, write their answer to the agent as an
 * `ask_answer` message with the id `ask-<questionId>`. The container's `ask`
 * tool waits for exactly that id. Any failure before the card is posted writes
 * the same id with `failed`, so the waiting tool returns an error at once.
 *
 * The card source is built here from the validated spec; every piece of text
 * goes in as initial state (entity-escaped), never into the source.
 */
import type { Access, CardEvent, CardRecord } from 'slack-ui-kit';
import { CardRenderError } from 'slack-ui-kit';

import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/types.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import { isDuplicate, takeEventContext } from './events.js';
import { kit, registerCardEventHandler } from './kit.js';
import { readInboundSender, shortMessage, stripSlack, threadTsFor } from './post-card.js';
import { slackClientForToken } from './slack-client.js';
import { escapeEntities } from './template.js';

export const ASK_LIMITS = {
  questions: [1, 4],
  question: 500,
  header: 60,
  options: [2, 10],
  label: 75,
  description: 75,
  users: 20,
} as const;

const QUESTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const GROUP_ID_RE = /^S[A-Z0-9]{2,}$/;

class AskError extends Error {}

export type AskSpecQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
};
export type AskSpecWho = { users?: string[]; group?: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, where: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new AskError(`${where} must be a string`);
  if (v.trim().length < min) throw new AskError(`${where} must not be empty`);
  if (v.length > max) throw new AskError(`${where} is too long`);
  return v;
}

function flag(v: unknown, where: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new AskError(`${where} must be true or false`);
  return v;
}

/** Validates the container's spec again, with the same limits as the tool. */
export function parseAskSpec(content: Obj): { questions: AskSpecQuestion[]; who?: AskSpecWho } {
  const raw = content.questions;
  const [qMin, qMax] = ASK_LIMITS.questions;
  if (!Array.isArray(raw) || raw.length < qMin || raw.length > qMax) {
    throw new AskError(`questions must have ${qMin} to ${qMax} entries`);
  }
  const questions = raw.map((rawQ, i): AskSpecQuestion => {
    const at = `questions[${i}]`;
    if (!isObj(rawQ)) throw new AskError(`${at} must be an object`);
    const question = text(rawQ.question, `${at}.question`, 1, ASK_LIMITS.question);
    const header =
      rawQ.header === undefined || rawQ.header === null
        ? undefined
        : text(rawQ.header, `${at}.header`, 1, ASK_LIMITS.header);
    const [oMin, oMax] = ASK_LIMITS.options;
    if (!Array.isArray(rawQ.options) || rawQ.options.length < oMin || rawQ.options.length > oMax) {
      throw new AskError(`${at}.options must have ${oMin} to ${oMax} entries`);
    }
    const options = rawQ.options.map((rawO, j) => {
      const where = `${at}.options[${j}]`;
      if (!isObj(rawO)) throw new AskError(`${where} must be an object`);
      const label = text(rawO.label, `${where}.label`, 1, ASK_LIMITS.label);
      const description =
        rawO.description === undefined || rawO.description === null
          ? undefined
          : text(rawO.description, `${where}.description`, 0, ASK_LIMITS.description);
      return description ? { label, description } : { label };
    });
    return {
      question,
      ...(header ? { header } : {}),
      options,
      multiSelect: flag(rawQ.multiSelect, `${at}.multiSelect`),
      allowOther: flag(rawQ.allowOther, `${at}.allowOther`),
    };
  });

  let who: AskSpecWho | undefined;
  if (content.who !== undefined && content.who !== null) {
    if (!isObj(content.who)) throw new AskError('who must be an object');
    const { users, group } = content.who;
    if (users !== undefined && group !== undefined) throw new AskError('who takes users or group, not both');
    if (users !== undefined) {
      if (!Array.isArray(users) || users.length === 0 || users.length > ASK_LIMITS.users) {
        throw new AskError(`who.users must have 1 to ${ASK_LIMITS.users} Slack user ids`);
      }
      if (!users.every((u) => typeof u === 'string' && USER_ID_RE.test(u))) {
        throw new AskError('who.users must be Slack user ids');
      }
      who = { users: users as string[] };
    } else if (group !== undefined) {
      if (typeof group !== 'string' || !GROUP_ID_RE.test(group))
        throw new AskError('who.group must be a Slack user group id');
      who = { group };
    }
  }
  return { questions, ...(who ? { who } : {}) };
}

/** The OpenUI Lang source and starting state for a spec. Only fixed text appears in the source. */
export function buildAskCard(questions: AskSpecQuestion[]): {
  source: string;
  state: Record<string, unknown>;
  required: string[][];
} {
  const lines: string[] = [];
  const children: string[] = [];
  const state: Record<string, unknown> = {};
  const required: string[][] = [];
  questions.forEach((q, i) => {
    lines.push(`$q${i} = ${q.multiSelect ? '[]' : '""'}`);
    lines.push(`$q${i}_text = ""`);
    lines.push(`$q${i}_opts = []`);
    if (q.allowOther) lines.push(`$q${i}_other = ""`);
    state[`q${i}_text`] = escapeEntities(q.header ? `*${q.header}*\n${q.question}` : q.question);
    state[`q${i}_opts`] = q.options.map((o, j) => ({
      v: String(j),
      l: escapeEntities(o.label),
      d: escapeEntities(o.description ?? ''),
    }));
    children.push(`s${i}`, `c${i}`);
    lines.push(`s${i} = Section($q${i}_text)`);
    const control = q.multiSelect ? 'Checkboxes' : 'Radio';
    lines.push(`c${i} = ${control}("q${i}", $q${i}, @Each($q${i}_opts, "o", Option(o.v, o.l, o.d)))`);
    if (q.allowOther) {
      children.push(`t${i}`);
      lines.push(`t${i} = TextBox("Or type your own answer", $q${i}_other)`);
    }
    required.push(q.allowOther ? [`q${i}`, `q${i}_other`] : [`q${i}`]);
  });
  children.push('acts');
  const source = [
    `root = Root([${children.join(', ')}])`,
    '$sent = false',
    ...lines,
    'acts = Actions([send])',
    'send = Button("Send", Action([@Set($sent, true)]), "primary")',
  ].join('\n');
  return { source, state, required };
}

/** Who may answer. The asker (`owner`) is left out of a users list when unknown. */
export function askAccess(who: AskSpecWho | undefined, owner: string): Access {
  if (who?.group) return { default: { group: who.group } };
  if (who?.users) {
    const users = [...new Set([...(owner ? [owner] : []), ...who.users])];
    return { default: { users } };
  }
  return { default: 'owner' };
}

async function writeAskRow(
  session: Session,
  content: Obj,
  questionId: string,
  payload: Obj,
  wake: boolean,
): Promise<void> {
  const channel = typeof content.channel === 'string' ? content.channel : undefined;
  const threadTs = channel ? threadTsFor(content.threadId, channel) : null;
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `ask-${questionId}`,
      kind: 'webhook',
      timestamp: new Date().toISOString(),
      platformId: channel ? `slack:${channel}` : null,
      channelType: 'slack',
      threadId: channel && threadTs ? `slack:${channel}:${threadTs}` : null,
      trigger: true,
      content: JSON.stringify({ source: 'slack-ui', event: 'ask_answer', payload: { questionId, ...payload } }),
    });
  } catch (err) {
    if (isDuplicate(err)) {
      log.debug('slack-ui: duplicate ask row ignored', { questionId });
      return;
    }
    throw err;
  }
  if (wake) await requestWake((await getSession(session.id)) ?? session, 'interactive');
}

async function ask(content: Obj, session: Session): Promise<void> {
  const { questionId } = content;
  if (typeof questionId !== 'string' || !QUESTION_ID_RE.test(questionId)) throw new AskError('invalid questionId');
  const spec = parseAskSpec(content);

  if (!session.messaging_group_id) throw new AskError('this session has no chat to post into');
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) throw new AskError('this session has no chat to post into');
  if (mg.channel_type !== 'slack') throw new AskError('questions can only be asked in a Slack chat');
  const channel = stripSlack(mg.platform_id);
  content.channel = channel;
  const instance = mg.instance ?? mg.channel_type;
  const token = envValue(botTokenKeyForInstance(instance));
  if (!token) throw new AskError('Slack is not configured for this chat');
  const threadTs = threadTsFor(content.threadId, channel) ?? threadTsFor(session.thread_id, channel);

  const existing = await getCardById(questionId);
  if (existing) {
    if (existing.meta?.sessionId !== session.id) throw new AskError('question id already in use');
    return; // redelivery of a card that was already posted
  }

  const owner = readInboundSender(session, content.inReplyTo) ?? '';
  const { source, state, required } = buildAskCard(spec.questions);
  try {
    await kit.render(source, state);
  } catch (err) {
    throw new AskError(`the question card could not be rendered: ${shortMessage(err)}`);
  }
  await kit.postCard(slackClientForToken(token), { channel, ...(threadTs ? { threadTs } : {}) }, source, {
    owner,
    access: askAccess(spec.who, owner),
    trusted: true,
    placeholder: false,
    state,
    required,
    meta: {
      kind: 'ask',
      cardId: questionId,
      questionId,
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
      instance,
      questions: spec.questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label) })),
    },
  });
}

export async function handleAsk(content: Obj, session: Session): Promise<void> {
  try {
    await ask(content, session);
  } catch (err) {
    const reason =
      err instanceof AskError ||
      err instanceof CardRenderError ||
      (err instanceof Error && err.name === 'SlackApiError')
        ? shortMessage(err)
        : 'unexpected error (see host log)';
    log.warn('slack-ui: ask failed', { err: err instanceof Error ? err.message : String(err) });
    const questionId = content.questionId;
    if (typeof questionId !== 'string' || !QUESTION_ID_RE.test(questionId)) return;
    try {
      await writeAskRow(session, content, questionId, { failed: reason }, false);
    } catch (writeErr) {
      log.error('slack-ui: could not write ask failure', { err: String(writeErr) });
    }
  }
}

function stateValue(state: Obj, name: string): unknown {
  return state[`$${name}`] ?? state[name];
}

type StoredQuestion = { question: string; options: string[] };

function storedQuestions(meta: Obj | undefined): StoredQuestion[] | undefined {
  const raw = meta?.questions;
  if (!Array.isArray(raw)) return undefined;
  const out: StoredQuestion[] = [];
  for (const q of raw) {
    if (!isObj(q) || typeof q.question !== 'string' || !Array.isArray(q.options)) return undefined;
    out.push({ question: q.question, options: q.options.map((o) => String(o)) });
  }
  return out;
}

/** The labels chosen for one question: its state value is an option index ("1") or a list of them. */
function chosenLabels(value: unknown, options: string[]): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  const labels: string[] = [];
  for (const v of values) {
    const label = options[Number(v)];
    if (typeof v === 'string' && /^\d+$/.test(v) && label !== undefined) labels.push(label);
  }
  return labels;
}

/** Only the press that locked the card is an answer. */
export async function writeAskAnswer(event: CardEvent, _stored?: CardRecord): Promise<void> {
  if (!event.locked) return;
  const questionId = event.meta?.questionId;
  const sessionId = event.meta?.sessionId;
  const agentGroupId = event.meta?.agentGroupId;
  const questions = storedQuestions(event.meta);
  if (
    typeof questionId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof agentGroupId !== 'string' ||
    !questions
  ) {
    log.warn('slack-ui: ask card event without host metadata, no answer written', { ts: event.card.ts });
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    log.error('slack-ui: ask session missing, no answer written', { questionId, session: sessionId });
    return;
  }
  const ctx = takeEventContext(event.card.channel, event.card.ts, event.user);
  const answers = questions.map((q, i) => {
    const other = stateValue(event.state, `q${i}_other`);
    const otherText = typeof other === 'string' ? other.trim() : '';
    return {
      question: q.question,
      selected: chosenLabels(stateValue(event.state, `q${i}`), q.options),
      ...(otherText ? { other: otherText } : {}),
    };
  });
  await writeAskRow(
    session,
    {
      channel: event.card.channel,
      threadId: event.card.threadTs ? `slack:${event.card.channel}:${event.card.threadTs}` : null,
    },
    questionId,
    { user: { id: event.user, name: ctx?.userName ?? '' }, answers },
    true,
  );
}

registerCardEventHandler('ask', writeAskAnswer);

registerDeliveryAction(
  'ask',
  handleAsk,
  unguarded(
    "posts only into the session's own chat; who may answer comes from the spec's own who, never widening beyond named users or a group",
  ),
);
