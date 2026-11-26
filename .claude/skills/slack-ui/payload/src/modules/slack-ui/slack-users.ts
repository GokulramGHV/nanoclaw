/**
 * `ncl slack-users lookup --email <addr>`: a Slack user id from a work email.
 *
 * The agent has no Slack token, so the host makes the call with the bot token
 * of the Slack instance the caller's chat runs on. Read only; only a real,
 * active person is returned, and only id and names (never the email, profile,
 * phone or title). The token never appears in output, errors or logs.
 */
import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { allowAtGroupScope } from '../../cli/registry.js';
import { registerResource } from '../../cli/crud.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';

const LOOKUP_TIMEOUT_MS = 5_000;
const NOT_FOUND = 'no active Slack user with that email';

export interface SlackUserMatch {
  id: string;
  name: string;
  real_name: string;
}

/** One `@`, no whitespace, at most 254 chars; returned lower-cased. */
export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const at = email.indexOf('@');
  if (
    !email ||
    email.length > 254 ||
    /\s/.test(email) ||
    at < 1 ||
    at !== email.lastIndexOf('@') ||
    at === email.length - 1
  ) {
    throw new Error('--email must be a single email address');
  }
  return email;
}

async function resolveInstance(
  args: Record<string, unknown>,
  ctx: { caller: string; messagingGroupId?: string },
): Promise<string> {
  if (ctx.caller !== 'agent') {
    const instance = typeof args.instance === 'string' ? args.instance : '';
    if (!instance) throw new Error('--instance <name> is required when running from the host (for example "slack")');
    return instance;
  }
  const mg = ctx.messagingGroupId ? await getMessagingGroup(ctx.messagingGroupId) : undefined;
  if (!mg || mg.channel_type !== 'slack') throw new Error('slack-users lookup only works from a Slack chat');
  return mg.instance ?? mg.channel_type;
}

/** Slack's `users.lookupByEmail`, form-encoded. Every failure text is token free. */
async function lookupByEmail(token: string, email: string): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch('https://slack.com/api/users.lookupByEmail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }).toString(),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Slack lookup failed: request error or timeout');
  }
  let body: Record<string, any>;
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    throw new Error(`Slack lookup failed: HTTP ${res.status}, non-JSON body`);
  }
  if (body.ok === true) return body;
  const code = String(body.error ?? `HTTP ${res.status}`);
  if (code === 'users_not_found') throw new Error(NOT_FOUND);
  if (code === 'missing_scope') throw new Error('Slack lookup failed: the Slack app needs the users:read.email scope');
  // Only a plain error code is echoed; anything else (which could carry arbitrary text) is not.
  throw new Error(`Slack lookup failed: ${/^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown_error'}`);
}

export async function lookupSlackUser(
  args: Record<string, unknown>,
  ctx: { caller: string; messagingGroupId?: string },
): Promise<SlackUserMatch> {
  const email = normalizeEmail(args.email);
  const instance = await resolveInstance(args, ctx);
  const token = envValue(botTokenKeyForInstance(instance));
  if (!token) throw new Error(`no Slack bot token is configured for instance "${instance}"`);
  const user = (await lookupByEmail(token, email)).user as Record<string, any> | undefined;
  if (
    !user ||
    typeof user.id !== 'string' ||
    user.deleted === true ||
    user.is_bot === true ||
    user.is_app_user === true
  ) {
    throw new Error(NOT_FOUND);
  }
  const realName = typeof user.real_name === 'string' ? user.real_name : '';
  const display = typeof user.profile?.display_name === 'string' ? user.profile.display_name : '';
  return { id: user.id, name: display || realName, real_name: realName };
}

registerResource({
  name: 'slack-user',
  plural: 'slack-users',
  // There is no slack-users table; with no generic operations nothing reads it.
  table: 'slack_users',
  description: 'Slack people, looked up by email with the bot token of the current Slack chat.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    lookup: {
      access: 'open',
      description:
        'Find the Slack user id for a work email. Returns id, name and real_name of an active person only. ' +
        'Needs the Slack app scopes users:read and users:read.email.',
      args: [
        { name: 'email', type: 'string', required: true, description: 'Email address to look up.' },
        { name: 'instance', type: 'string', description: 'Slack instance (host only; an agent uses its own chat).' },
      ],
      examples: ['ncl slack-users lookup --email ada@example.com'],
      handler: (args, ctx) => lookupSlackUser(args, ctx as { caller: string; messagingGroupId?: string }),
      formatHuman: (data) => {
        const u = data as SlackUserMatch;
        return `${u.id} ${u.name}`;
      },
    },
  },
});

allowAtGroupScope('slack-users');
