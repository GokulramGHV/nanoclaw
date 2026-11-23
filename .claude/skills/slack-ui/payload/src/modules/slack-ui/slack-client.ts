/**
 * The kit's `SlackClient` over the host's fetch-based Slack library, for one
 * bot token. The kit reads Slack's error code at `err.data.error` (for
 * `invalid_blocks` and for its failure text), so every failure is rethrown with
 * that field set. The error stays a `SlackApiError`, so its message still
 * reaches the agent in a `post_card failed:` notice.
 */
import type { SlackClient } from 'slack-ui-kit';

import { botTokenKeyForInstance, SlackApiError, slackCall } from '../../channels/slack-lib.js';
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

/**
 * `usergroups.users.list` rejects a JSON body with `invalid_arguments` (seen
 * live), so this one call sends form-encoded arguments instead of going
 * through `slackCall`. Failures carry Slack's code at `data.error`.
 */
async function listGroupUsers(token: string, usergroup: string): Promise<{ users?: string[] }> {
  const fail = (code: string): never => {
    throw Object.assign(new SlackApiError('slack-ui-usergroup', `slack usergroups.users.list failed: ${code}`), {
      data: { error: code },
    });
  };
  let res: Response;
  try {
    res = await fetch('https://slack.com/api/usergroups.users.list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usergroup }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  let body: { ok?: unknown; error?: unknown; users?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return fail(`HTTP ${res.status}, non-JSON body`);
  }
  if (body.ok !== true) return fail(String(body.error ?? `HTTP ${res.status}`));
  return {
    users: Array.isArray(body.users) ? body.users.filter((u): u is string => typeof u === 'string') : undefined,
  };
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
      users: { list: (args) => listGroupUsers(token, args.usergroup) },
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
