/**
 * Read-only Slack Web API calls for thread context. Every call is sent
 * form-encoded: Slack refuses a JSON body on some read methods
 * (`invalid_arguments`), and form encoding works on all of them. Failures throw
 * a SlackApiError carrying Slack's own error code, never the token.
 */
import { SlackApiError } from '../../channels/slack-lib.js';

const SLACK_API = 'https://slack.com/api';

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  size?: number;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackThreadMessage {
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  files?: SlackFile[];
}

export async function slackForm(
  token: string,
  method: string,
  args: Record<string, string | number | boolean | undefined>,
): Promise<Record<string, any>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined) body.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new SlackApiError(
      'thread-context',
      `slack ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let json: Record<string, any>;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {
    throw new SlackApiError('thread-context', `slack ${method} failed: HTTP ${res.status}, non-JSON body`);
  }
  if (json.ok !== true) {
    throw new SlackApiError('thread-context', `slack ${method} failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return json;
}

/** Page size of conversations.replies, and the page cap that bounds a very long thread. */
export const REPLIES_PAGE_SIZE = 200;
export const REPLIES_MAX_PAGES = 10;

/** The thread's messages before `latest` (exclusive), root first, with whether the page cap cut the read short. */
export async function fetchReplies(
  token: string,
  channel: string,
  threadTs: string,
  latest: string,
): Promise<{ messages: SlackThreadMessage[]; truncated: boolean }> {
  const messages: SlackThreadMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < REPLIES_MAX_PAGES; page++) {
    const json = await slackForm(token, 'conversations.replies', {
      channel,
      ts: threadTs,
      latest,
      inclusive: false,
      limit: REPLIES_PAGE_SIZE,
      cursor,
    });
    for (const m of (json.messages as unknown[] | undefined) ?? []) {
      if (m && typeof (m as SlackThreadMessage).ts === 'string') messages.push(m as SlackThreadMessage);
    }
    cursor = (json.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) return { messages, truncated: false };
  }
  return { messages, truncated: true };
}

export interface SlackPerson {
  name: string;
  email?: string;
}

const people = new Map<string, { at: number; person: SlackPerson }>();
const PERSON_TTL_MS = 60 * 60 * 1000;

/** A user's display name and email (email needs users:read.email). Cached an hour; null when Slack refuses. */
export async function userInfo(token: string, userId: string, now = Date.now()): Promise<SlackPerson | null> {
  const key = `${token}\n${userId}`;
  const hit = people.get(key);
  if (hit && now - hit.at < PERSON_TTL_MS) return hit.person;
  try {
    const json = await slackForm(token, 'users.info', { user: userId });
    const u = json.user as { name?: string; real_name?: string; profile?: Record<string, any> } | undefined;
    const profile = u?.profile ?? {};
    const name = [profile.display_name, profile.real_name, u?.real_name, u?.name].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    const person: SlackPerson = {
      name: name ?? userId,
      email: typeof profile.email === 'string' && profile.email ? profile.email : undefined,
    };
    people.set(key, { at: now, person });
    return person;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a name that cannot be resolved falls back to the id
  } catch {
    return null;
  }
}

export function clearPeopleCache(): void {
  people.clear();
}

export async function permalink(token: string, channel: string, messageTs: string): Promise<string | null> {
  try {
    const json = await slackForm(token, 'chat.getPermalink', { channel, message_ts: messageTs });
    return typeof json.permalink === 'string' ? json.permalink : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- the link is optional
  } catch {
    return null;
  }
}
