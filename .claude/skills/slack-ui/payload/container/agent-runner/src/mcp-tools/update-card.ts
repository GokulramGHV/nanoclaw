/**
 * update_card MCP tool: redraw a card this agent group posted earlier.
 *
 * Fire-and-forget like post_card: the tool writes a system action row and
 * returns. The host looks the card up, validates `data` against its template
 * and redraws the same Slack message.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

import { writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/** Same shape post_card gives its card ids (the host checks the same pattern). */
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
    real = realpathSync(path);
  } catch {
    return { error: outside };
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

export const updateCard: McpToolDefinition = {
  tool: {
    name: 'update_card',
    description:
      'Redraw a card this agent group posted earlier, in place, with new data. Same template, owner, press rules and message. Send the full data again (inline `data`, or `dataFile` when a script already wrote it, so nothing is retyped): fields you leave out go back to the template defaults. Works on locked cards (they stay locked) and from any session of this agent group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cardId: {
          type: 'string',
          description: 'The card id returned when you posted the card (or the cardId in its card_event).',
        },
        data: {
          type: 'object',
          description:
            "The template's data fields, exactly as its `data` section declares them, all of them again. Defaults to {}.",
        },
        dataFile: {
          type: 'string',
          description:
            'Optional, instead of data. Absolute path of a JSON file under /workspace/agent/ that a script wrote with exactly the template\'s data fields (an object, up to 256 KB). Prefer it whenever a script already wrote the data, so nothing is retyped.',
        },
      },
      required: ['cardId'],
    },
  },
  async handler(args) {
    const rawId = args.cardId;
    if (typeof rawId !== 'string' || !rawId.trim()) return err('cardId must be a non-empty string');
    const cardId = rawId.trim();
    if (!CARD_ID_RE.test(cardId)) return err('cardId is not a valid card id');

    let data: unknown = args.data === undefined ? {} : args.data;
    if (args.dataFile !== undefined) {
      if (args.data !== undefined) return err('give either data or dataFile, not both');
      if (typeof args.dataFile !== 'string' || !args.dataFile) return err('dataFile must be a file under /workspace/agent/');
      const read = readDataFile(args.dataFile);
      if ('error' in read) return err(read.error);
      data = read.data;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return err('data must be an object');

    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'update_card',
        cardId,
        data,
        inReplyTo: getCurrentInReplyTo(),
      }),
    });

    log(`update_card: ${cardId}`);
    return ok(`Card ${cardId} update queued.`);
  },
};

registerTools([updateCard]);
