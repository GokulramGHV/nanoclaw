import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { inboxFolderName, isSafeAttachmentName } from '../../attachment-safety.js';
import { AnchoredDir } from '../../anchored-dir.js';
import { sessionDir, withExistingMailboxSession } from '../../session-manager.js';
import { registerWakeContext, type ContextBlock, type ContextLine, type WakeContextInput } from '../../wake-context.js';
import { isEnabled } from './settings.js';
import { fetchReplies, permalink, userInfo, type SlackFile, type SlackThreadMessage } from './slack-api.js';

/** Messages kept before the engaged one, besides the thread's first. */
export const DEFAULT_MAX_MESSAGES = 200;
/** Largest file saved for the agent. */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Most files saved from one thread. */
export const MAX_FILES = 25;
/** Characters of message text in one block, and in one message. */
export const MAX_BLOCK_CHARS = 30_000;
export const MAX_MESSAGE_CHARS = 4_000;
/** Distinct authors looked up per wake. */
const MAX_AUTHORS = 30;

function intEnv(key: string, fallback: number): number {
  const n = Number(envValue(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Slack timestamps order as (seconds, microseconds). */
function tsKey(ts: string): [number, number] {
  const [s, f = '0'] = ts.split('.');
  return [Number(s), Number(f)];
}
export function tsBefore(a: string, b: string): boolean {
  const [as, af] = tsKey(a);
  const [bs, bf] = tsKey(b);
  return as < bs || (as === bs && af < bf);
}

const SLACK_TS = /^\d+\.\d+$/;

interface Trigger {
  id?: string;
  timestamp?: string;
  content?: unknown;
}

function triggerContent(trigger: Trigger): Record<string, any> {
  const c = trigger.content;
  if (typeof c === 'string') {
    try {
      const parsed = JSON.parse(c);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return c && typeof c === 'object' ? (c as Record<string, any>) : {};
}

/** `slack:<channel>:<threadTs>` -> parts, or null. */
function threadParts(threadId: unknown): { channel: string; ts: string } | null {
  if (typeof threadId !== 'string') return null;
  const parts = threadId.split(':');
  if (parts.length !== 3 || parts[0] !== 'slack' || !parts[1] || !SLACK_TS.test(parts[2])) return null;
  return { channel: parts[1], ts: parts[2] };
}

/** Message timestamps this session already holds: inbound rows and its own delivered posts. */
async function seenTimestamps(input: WakeContextInput): Promise<Set<string>> {
  const seen = new Set<string>();
  const rows = await withExistingMailboxSession(input.agentGroup.id, input.session.id, (mailbox) => ({
    inbound: mailbox.getInboundHistory(1000),
    outbound: mailbox.getOutboundHistory(1000),
  }));
  for (const row of rows?.inbound ?? []) {
    try {
      const c = JSON.parse(row.content) as Record<string, unknown>;
      for (const v of [c.id, c.ts]) if (typeof v === 'string' && SLACK_TS.test(v)) seen.add(v);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a row that is not JSON holds no timestamp
    } catch {
      /* skip */
    }
  }
  for (const row of rows?.outbound ?? []) {
    if (row.platformMessageId && SLACK_TS.test(row.platformMessageId)) seen.add(row.platformMessageId);
  }
  return seen;
}

/** Slack's markup to plain text: links, entities, and mentions of people already resolved. */
export function plainText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isBot(m: SlackThreadMessage): boolean {
  return Boolean(m.bot_id) || m.subtype === 'bot_message';
}

interface FileNote {
  /** Text appended to the message line. */
  note: string;
}

/** Download one file into the session inbox. Never throws. */
async function saveFile(
  file: SlackFile,
  token: string,
  inbox: { dir: AnchoredDir | null | undefined; folder: string },
  open: () => AnchoredDir | null,
  capBytes: number,
): Promise<FileNote> {
  const name = file.name || file.title || 'file';
  const skip = (why: string): FileNote => ({ note: `[file: ${name} — skipped: ${why}]` });
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (typeof file.size === 'number' && file.size > capBytes) {
    return skip(`${mb(file.size)} is over the ${mb(capBytes)} limit`);
  }
  const url = file.url_private_download || file.url_private;
  if (!url) return skip('Slack gave no download link');
  const safe = `${file.id ?? 'file'}-${name}`;
  if (!isSafeAttachmentName(safe)) return skip('unsafe file name');
  try {
    const dir = inbox.dir ?? open();
    inbox.dir = dir;
    if (!dir) return skip('could not open the inbox');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return skip(`download failed (HTTP ${res.status})`);
    if ((res.headers.get('content-type') ?? '').startsWith('text/html') && !(file.mimetype ?? '').startsWith('text/')) {
      return skip('download refused (the app may lack files:read)');
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > capBytes) return skip(`${mb(data.length)} is over the ${mb(capBytes)} limit`);
    try {
      dir.writeNewFile(safe, data);
    } catch (err) {
      // A redelivered message finds the file already saved.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { note: `[file: ${name} — saved to /workspace/inbox/${inbox.folder}/${safe}]` };
    // eslint-disable-next-line no-catch-all/no-catch-all -- one file failing costs only that file
  } catch (err) {
    log.warn('Thread file not saved', { file: name, err: err instanceof Error ? err.message : String(err) });
    return skip('could not be downloaded');
  }
}

function clip(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [message cut]` : text;
}

function failureBlock(input: WakeContextInput, why: string): ContextBlock {
  return {
    key: 'thread',
    tag: 'slack-thread',
    about: 'Earlier messages of this Slack thread',
    lines: [
      {
        sender: 'system',
        time: input.trigger.timestamp || new Date().toISOString(),
        text: `The earlier messages of this thread could not be read (${why}).`,
      },
    ],
  };
}

/** The thread's earlier messages and files, plus who asked and the thread link. Never throws. */
export async function threadContext(input: WakeContextInput): Promise<ContextBlock[]> {
  try {
    if (input.mg.channel_type !== 'slack') return [];
    if (!(await isEnabled(input.agentGroup.id))) return [];
    const trigger = input.trigger as Trigger;
    const content = triggerContent(trigger);
    const own = [trigger.id, content.id].find((v): v is string => typeof v === 'string' && SLACK_TS.test(v));
    const thread = threadParts(content.threadId) ?? threadParts(input.session.thread_id);
    if (!own || !thread || thread.ts === own) return [];
    return await read(input, content, own, thread);
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the message goes through either way
  } catch (err) {
    log.warn('Slack thread context failed', {
      sessionId: input.session.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return [failureBlock(input, 'unexpected error')];
  }
}

async function read(
  input: WakeContextInput,
  content: Record<string, any>,
  own: string,
  thread: { channel: string; ts: string },
): Promise<ContextBlock[]> {
  const time = input.trigger.timestamp || new Date().toISOString();
  const token = envValue(botTokenKeyForInstance(input.mg.instance ?? input.mg.channel_type));
  if (!token) return [failureBlock(input, 'no bot token for this Slack app')];
  const maxMessages = intEnv('SLACK_THREAD_CONTEXT_MAX_MESSAGES', DEFAULT_MAX_MESSAGES);
  const capBytes = intEnv('SLACK_THREAD_CONTEXT_MAX_FILE_MB', DEFAULT_MAX_FILE_BYTES / (1024 * 1024)) * 1024 * 1024;
  const askerId = [content.senderId, content.author?.userId].find((v): v is string => typeof v === 'string');

  let replies;
  try {
    replies = await fetchReplies(token, thread.channel, thread.ts, own);
  } catch (err) {
    log.warn('Slack thread could not be read', {
      sessionId: input.session.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return [failureBlock(input, err instanceof Error ? err.message : 'Slack error')];
  }

  const seen = await seenTimestamps(input).catch(() => new Set<string>());
  const earlier = replies.messages.filter((m) => m.ts !== own && tsBefore(m.ts, own));
  const root = earlier.find((m) => m.ts === thread.ts);
  const fresh = earlier.filter((m) => !seen.has(m.ts));
  const alreadyHeld = earlier.length - fresh.length;
  const rootIsNew = root !== undefined && fresh[0]?.ts === root.ts;
  const rest = rootIsNew ? fresh.slice(1) : fresh;
  let kept = rest.slice(-maxMessages);
  let droppedByCount = rest.length - kept.length;

  // People: authors, the asker, and mentions are resolved in parallel, once each.
  const wanted = [
    ...new Set([...(rootIsNew ? [root!] : []), ...kept].map((m) => m.user).filter((u): u is string => !!u)),
  ];
  const lookups = [...new Set([...(askerId ? [askerId] : []), ...wanted.slice(0, MAX_AUTHORS)])];
  const [people, link] = await Promise.all([
    Promise.all(lookups.map(async (id) => [id, await userInfo(token, id)] as const)),
    permalink(token, thread.channel, thread.ts),
  ]);
  const names = new Map<string, string>(people.flatMap(([id, p]) => (p ? [[id, p.name] as const] : [])));

  // Files, saved into the session inbox like any attachment.
  const folder = inboxFolderName(`thread-${own}`) ?? `thread-${own.replace('.', '-')}`;
  const inbox: { dir: AnchoredDir | null | undefined; folder: string } = { dir: undefined, folder };
  const open = () => AnchoredDir.open(sessionDir(input.agentGroup.id, input.session.id), ['inbox', folder], true);
  let filesLeft = MAX_FILES;
  const notes = new Map<string, string[]>();
  try {
    for (const m of [...(rootIsNew ? [root!] : []), ...kept]) {
      for (const f of m.files ?? []) {
        if (filesLeft-- <= 0) {
          (notes.get(m.ts) ?? notes.set(m.ts, []).get(m.ts)!).push(
            `[file: ${f.name || f.title || 'file'} — skipped: more than ${MAX_FILES} files in this thread]`,
          );
          continue;
        }
        const r = await saveFile(f, token, inbox, open, capBytes);
        (notes.get(m.ts) ?? notes.set(m.ts, []).get(m.ts)!).push(r.note);
      }
    }
  } finally {
    inbox.dir?.close();
  }

  const toLine = (m: SlackThreadMessage): ContextLine => {
    const author = m.user
      ? (names.get(m.user) ?? m.user)
      : (m.username ?? m.bot_profile?.name ?? m.bot_id ?? 'unknown');
    const sender = isBot(m) ? `${author} (bot)` : author;
    const body = [clip(plainText(m.text ?? '', names)), ...(notes.get(m.ts) ?? [])].filter(Boolean).join('\n');
    return {
      id: m.ts,
      sender,
      time: new Date(Number(m.ts.split('.')[0]) * 1000).toISOString(),
      text: body,
    };
  };

  // Over the text budget: drop the oldest of the rest, never the first message.
  const first = rootIsNew ? [toLine(root!)] : [];
  let lines = kept.map(toLine);
  const size = (ls: ContextLine[]) => [...first, ...ls].reduce((n, l) => n + l.text.length + l.sender.length + 40, 0);
  while (lines.length > 0 && size(lines) > MAX_BLOCK_CHARS) {
    lines = lines.slice(1);
    kept = kept.slice(1);
    droppedByCount++;
  }

  const blocks: ContextBlock[] = [];
  const notesOut: string[] = [];
  if (droppedByCount > 0) {
    notesOut.push(`${droppedByCount} older message${droppedByCount === 1 ? '' : 's'} after the first are not shown`);
  }
  if (replies.truncated) notesOut.push('the thread is longer than could be read');
  if (alreadyHeld > 0)
    notesOut.push(
      `${alreadyHeld} message${alreadyHeld === 1 ? ' is' : 's are'} not repeated because you already have them`,
    );
  const threadLines: ContextLine[] = [
    ...first,
    ...(notesOut.length > 0 ? [{ sender: 'system', time, text: `Left out: ${notesOut.join('; ')}.` }] : []),
    ...lines,
  ];
  if (threadLines.length > 0) {
    blocks.push({
      key: 'thread',
      tag: 'slack-thread',
      about:
        'Earlier messages of the Slack thread you were tagged into, oldest first, before the message that tagged you',
      lines: threadLines,
    });
  }

  const asker = askerId ? people.find(([id]) => id === askerId)?.[1] : null;
  const facts = [
    askerId
      ? `Asked by Slack user ${askerId}${asker ? ` (${asker.name}${asker.email ? `, ${asker.email}` : ''})` : ''}.`
      : '',
    link ? `Thread link: ${link}` : '',
  ].filter(Boolean);
  if (facts.length > 0) {
    blocks.push({
      key: 'asker',
      tag: 'slack-asker',
      about: 'Who tagged you and where this thread lives',
      lines: [{ sender: 'system', time, text: facts.join(' ') }],
    });
  }
  return blocks;
}

registerWakeContext('slack-thread-context', threadContext);
