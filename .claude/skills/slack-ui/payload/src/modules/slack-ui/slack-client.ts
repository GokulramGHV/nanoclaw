/**
 * The kit's `SlackClient` over the host's fetch-based Slack library, for one
 * bot token. The kit reads Slack's error code at `err.data.error` (for
 * `invalid_blocks` and for its failure text), so every failure is rethrown with
 * that field set. The error stays a `SlackApiError`, so its message still
 * reaches the agent in a `post_card failed:` notice.
 */
import type { SlackClient } from 'slack-ui-kit';

import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { envValue } from '../../env.js';

/** `slack <method> failed: <code>` -> `<code>`. */
function slackCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const at = msg.indexOf(' failed: ');
  return at === -1 ? msg : msg.slice(at + ' failed: '.length);
}

async function call(token: string, method: string, args: unknown, step: string): Promise<any> {
  try {
    return await slackCall(token, method, args as Record<string, unknown>, step);
  } catch (err) {
    if (err instanceof Error) {
      throw Object.assign(err, { data: { error: slackCode(err) } });
    }
    throw err;
  }
}

function build(token: string): SlackClient {
  return {
    chat: {
      postMessage: (args) => call(token, 'chat.postMessage', args, 'slack-ui-post'),
      update: (args) => call(token, 'chat.update', args, 'slack-ui-update'),
      delete: (args) => call(token, 'chat.delete', args, 'slack-ui-delete'),
      postEphemeral: (args) => call(token, 'chat.postEphemeral', args, 'slack-ui-ephemeral'),
    },
    views: { open: (args) => call(token, 'views.open', args, 'slack-ui-views-open') },
    usergroups: {
      users: { list: (args) => call(token, 'usergroups.users.list', args, 'slack-ui-usergroup') },
    },
  };
}

const clients = new Map<string, SlackClient>();

/** One client per token. */
export function slackClientForToken(token: string): SlackClient {
  let client = clients.get(token);
  if (!client) {
    client = build(token);
    clients.set(token, client);
  }
  return client;
}

/** The client for a Slack app instance, or undefined when its bot token is not configured. */
export function slackClientForInstance(instance: string): SlackClient | undefined {
  const token = envValue(botTokenKeyForInstance(instance));
  return token ? slackClientForToken(token) : undefined;
}
