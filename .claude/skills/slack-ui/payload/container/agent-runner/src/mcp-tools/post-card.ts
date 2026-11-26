/**
 * post_card MCP tool: request a predefined interactive card.
 *
 * Fire-and-forget: the tool writes a system action row and returns. The host
 * fills the agent group's card template with `data` and posts it; clicks come
 * back later as card_event messages.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, resolveDestinationThread } from '../db/session-routing.js';
import { getCurrentInReplyTo, getCurrentReplyRoute } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_TEMPLATE_LENGTH = 100;

const DATA_FILE_MAX_BYTES = 256 * 1024;
/** Root a `dataFile` must live under. NANOCLAW_DATA_FILE_ROOT replaces it (tests only). */
const dataFileRoot = () => process.env.NANOCLAW_DATA_FILE_ROOT || '/workspace/agent';

/**
 * Read a card's data from a JSON file a script wrote. The path must be absolute
 * and, after realpath (symlinks resolved), inside the root. Errors name the
 * problem and never echo the file's contents.
 */
function readDataFile(path: string): { data: Record<string, unknown> } | { error: string } {
  const outside = 'dataFile must be a file under /workspace/agent/';
  if (!isAbsolute(path)) return { error: outside };
  let real: string;
  let root: string;
  try {
    root = realpathSync(dataFileRoot());
  } catch {
    return { error: outside };
  }
  try {
    real = realpathSync(path);
  } catch (e) {
    // A missing file under the root is its own error, so a script that did not write it is easy to tell from a bad path.
    const lexical = resolve(path);
    const inRoot = lexical.startsWith(root + sep) || lexical.startsWith(resolve(dataFileRoot()) + sep);
    return { error: (e as NodeJS.ErrnoException).code === 'ENOENT' && inRoot ? 'dataFile does not exist' : outside };
  }
  if (real !== root && !real.startsWith(root + sep)) return { error: outside };
  let text: string;
  try {
    if (!statSync(real).isFile()) return { error: outside };
    if (statSync(real).size > DATA_FILE_MAX_BYTES) return { error: 'dataFile is larger than 256 KB' };
    text = readFileSync(real, 'utf8');
  } catch {
    return { error: 'dataFile could not be read' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'dataFile is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'dataFile must hold a JSON object' };
  }
  return { data: parsed as Record<string, unknown> };
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Same threading as send_card (interactive.ts): the bound thread is the last resort. */
function routing() {
  const session = getSessionRouting();
  const thread =
    session.channel_type && session.platform_id
      ? resolveDestinationThread(session.channel_type, session.platform_id, getCurrentReplyRoute())
      : null;
  return { ...session, thread_id: thread?.threadId ?? session.thread_id };
}

export const postCard: McpToolDefinition = {
  tool: {
    name: 'post_card',
    description:
      "Post a predefined interactive card from this agent group's card templates. Pass the template name and its data only (inline `data`, or `dataFile` when a script already wrote it, so nothing is retyped); the layout and who can press each control come from the template. To post an updated version of a card you posted earlier, pass the id of the most recent version in `replaces`: the old card closes once the new one is posted.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        template: { type: 'string', description: 'Card template name (a file in cards/, without .json).' },
        data: {
          type: 'object',
          description:
            "The template's data fields, exactly as its `data` section declares them (read /workspace/agent/plugins/<plugin>/cards/<template>.json). Defaults to {}.",
        },
        dataFile: {
          type: 'string',
          description:
            'Optional, instead of data. Absolute path of a JSON file under /workspace/agent/ that a script wrote with exactly the template\'s data fields (an object, up to 256 KB). Prefer it whenever a script already wrote the data, so nothing is retyped.',
        },
        alsoToChannel: {
          type: 'boolean',
          description:
            'Optional, only on Slack: when the card is a reply in a thread, also show it in the channel. It stays one message, so update_card changes it in both places. Ignored outside a thread.',
        },
        replaces: {
          type: 'string',
          description:
            'Optional. The card id of the most recent version of this card from this session (the id returned when you posted it, or the cardId in its card_event). The new card keeps its owner and the old card is closed after the new one posts.',
        },
      },
      required: ['template'],
    },
  },
  async handler(args) {
    const rawTemplate = args.template;
    if (typeof rawTemplate !== 'string' || !rawTemplate.trim()) return err('template must be a non-empty string');
    const template = rawTemplate.trim();
    if (template.length > MAX_TEMPLATE_LENGTH) return err(`template must be at most ${MAX_TEMPLATE_LENGTH} characters`);

    let data: unknown = args.data === undefined ? {} : args.data;
    if (args.dataFile !== undefined) {
      if (args.data !== undefined) return err('give either data or dataFile, not both');
      if (typeof args.dataFile !== 'string' || !args.dataFile) return err('dataFile must be a file under /workspace/agent/');
      const read = readDataFile(args.dataFile);
      if ('error' in read) return err(read.error);
      data = read.data;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return err('data must be an object');

    const rawReplaces = args.replaces;
    if (rawReplaces !== undefined && rawReplaces !== null && typeof rawReplaces !== 'string')
      return err('replaces must be a string');
    const replaces = typeof rawReplaces === 'string' && rawReplaces.trim() ? rawReplaces.trim() : undefined;

    const cardId = randomUUID();
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'post_card',
        cardId,
        template,
        data,
        ...(replaces ? { replaces } : {}),
        ...(args.alsoToChannel === true ? { alsoToChannel: true } : {}),
        threadId: routing().thread_id,
        inReplyTo: getCurrentInReplyTo(),
      }),
    });

    log(`post_card: ${cardId} template=${template}`);
    return ok(`Card ${cardId} queued. Clicks arrive later as card_event messages; don't wait for them.`);
  },
};

registerTools([postCard]);
