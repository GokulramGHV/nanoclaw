/**
 * post_card MCP tool: request a predefined interactive card.
 *
 * Fire-and-forget: the tool writes a system action row and returns. The host
 * fills the agent group's card template with `data` and posts it; clicks come
 * back later as card_event messages.
 */
import { randomUUID } from 'node:crypto';

import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, resolveDestinationThread } from '../db/session-routing.js';
import { getCurrentInReplyTo, getCurrentReplyRoute } from '../db/session-state.js';
import { holdBarrier } from '../progress-seam.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_TEMPLATE_LENGTH = 100;

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
      "Post a predefined interactive card from this agent group's card templates. Pass the template name and its data only; the layout and who can press each control come from the template.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        template: { type: 'string', description: 'Card template name (a file in cards/, without .json).' },
        data: {
          type: 'object',
          description:
            "The template's data fields, exactly as its `data` section declares them (read /workspace/agent/plugins/<plugin>/cards/<template>.json). Defaults to {}.",
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

    const data = args.data === undefined ? {} : args.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return err('data must be an object');

    const cardId = randomUUID();
    // Held text for this chat goes first, so the card has its context and the order is kept.
    const platformId = routing().platform_id;
    if (platformId) await holdBarrier(platformId);
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'post_card',
        cardId,
        template,
        data,
        threadId: routing().thread_id,
        inReplyTo: getCurrentInReplyTo(),
      }),
    });

    log(`post_card: ${cardId} template=${template}`);
    return ok(`Card ${cardId} queued. Clicks arrive later as card_event messages; don't wait for them.`);
  },
};

registerTools([postCard]);
