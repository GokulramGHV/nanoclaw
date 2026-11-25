/**
 * update_card MCP tool: redraw a card this agent group posted earlier.
 *
 * Fire-and-forget like post_card: the tool writes a system action row and
 * returns. The host looks the card up, validates `data` against its template
 * and redraws the same Slack message.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

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
      'Redraw a card this agent group posted earlier, in place, with new data. Same template, owner, press rules and message. Send the full data again: fields you leave out go back to the template defaults. Works on locked cards (they stay locked) and from any session of this agent group.',
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
      },
      required: ['cardId'],
    },
  },
  async handler(args) {
    const rawId = args.cardId;
    if (typeof rawId !== 'string' || !rawId.trim()) return err('cardId must be a non-empty string');
    const cardId = rawId.trim();

    const data = args.data === undefined ? {} : args.data;
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
