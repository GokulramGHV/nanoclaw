/**
 * The Slack Web API calls team access needs. Reads are form-encoded (Slack
 * refuses a JSON body on some read methods); writes go through the shared
 * JSON helper. Failures throw SlackApiError with Slack's own error code and
 * never the token.
 */
import { SlackApiError, slackCall } from '../../channels/slack-lib.js';

const SLACK_API = 'https://slack.com/api';

async function slackRead(
  token: string,
  method: string,
  args: Record<string, string | number | boolean | undefined>,
  timeoutMs: number,
): Promise<Record<string, any>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined) body.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SlackApiError(
      'team-access',
      `slack ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let json: Record<string, any>;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {
    throw new SlackApiError('team-access', `slack ${method} failed: HTTP ${res.status}, non-JSON body`);
  }
  if (json.ok !== true) {
    throw new SlackApiError('team-access', `slack ${method} failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return json;
}

/** Whether the channel is shared with another organization. A response without a channel object throws. */
export async function fetchIsExtShared(token: string, channel: string, timeoutMs: number): Promise<boolean> {
  const json = await slackRead(token, 'conversations.info', { channel }, timeoutMs);
  const c = json.channel as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') throw new SlackApiError('team-access', 'slack conversations.info: no channel');
  return c.is_ext_shared === true;
}

/** The user ids in a Slack user group. A response without a users array throws. */
export async function fetchUserGroupMembers(token: string, usergroup: string, timeoutMs: number): Promise<string[]> {
  const json = await slackRead(token, 'usergroups.users.list', { usergroup }, timeoutMs);
  if (!Array.isArray(json.users)) throw new SlackApiError('team-access', 'slack usergroups.users.list: no users');
  return (json.users as unknown[]).filter((u): u is string => typeof u === 'string');
}

/**
 * An ephemeral note to one user, in the thread when given. A DM cannot hold an
 * ephemeral on every plan, so a failed DM ephemeral falls back to a plain post
 * into that DM (only the sender and the bot are there).
 */
export async function postEphemeralNote(
  token: string,
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  try {
    await slackCall(
      token,
      'chat.postEphemeral',
      { channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
      'team-access',
    );
  } catch (err) {
    if (!channel.startsWith('D')) throw err;
    await slackCall(token, 'chat.postMessage', { channel, text }, 'team-access');
  }
}
