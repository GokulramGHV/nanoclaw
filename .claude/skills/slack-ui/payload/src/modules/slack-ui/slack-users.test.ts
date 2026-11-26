import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import '../../cli/commands/index.js';
import './slack-users.js';
import { envValue } from '../../env.js';

const TOKEN = 'xoxb-SENTINEL-token-123';
const agent = (messagingGroupId: string): CallerContext => ({
  caller: 'agent',
  agentGroupId: 'ag-1',
  sessionId: 's-1',
  messagingGroupId,
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

function slackReplies(body: unknown): void {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(body)));
}

function lookup(ctx: CallerContext, args: Record<string, unknown>) {
  return dispatch({ id: '1', command: 'slack-users-lookup', args }, ctx);
}

async function errText(ctx: CallerContext, args: Record<string, unknown>): Promise<string> {
  const res = await lookup(ctx, args);
  expect(res.ok).toBe(false);
  return res.ok ? '' : res.error.message;
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now });
  const mg = (id: string, channel_type: string, instance: string | null) =>
    createMessagingGroup({
      id,
      channel_type,
      platform_id: id,
      instance,
      name: id,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    } as never);
  await mg('mg-slack', 'slack', null);
  await mg('mg-named', 'slack', 'slack-alpha');
  await mg('mg-tg', 'telegram', null);
  vi.mocked(envValue).mockImplementation((key: string) =>
    key === 'SLACK_BOT_TOKEN' || key === 'SLACK_BOT_TOKEN_ALPHA' ? `${TOKEN}-${key}` : undefined,
  );
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('ncl slack-users lookup', () => {
  it('returns id, name and real_name only, lower-casing the email', async () => {
    slackReplies({
      ok: true,
      user: {
        id: 'U1',
        real_name: 'Ada Lovelace',
        profile: { display_name: 'ada', email: 'ada@example.com', phone: '555', title: 'Eng' },
        tz: 'UTC',
      },
    });
    const res = await lookup(agent('mg-slack'), { email: ' Ada@Example.com ' });
    expect(res).toMatchObject({ ok: true, data: { id: 'U1', name: 'ada', real_name: 'Ada Lovelace' } });
    expect(Object.keys((res as { data: object }).data).sort()).toEqual(['id', 'name', 'real_name']);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://slack.com/api/users.lookupByEmail');
    expect(String((init as RequestInit).body)).toBe('email=ada%40example.com');
  });

  it('falls back to the real name when there is no display name', async () => {
    slackReplies({ ok: true, user: { id: 'U1', real_name: 'Ada Lovelace', profile: { display_name: '' } } });
    const res = await lookup(agent('mg-slack'), { email: 'ada@example.com' });
    expect(res).toMatchObject({ ok: true, data: { name: 'Ada Lovelace' } });
  });

  it("uses the token of the chat's own instance", async () => {
    slackReplies({ ok: true, user: { id: 'U1', real_name: 'A' } });
    await lookup(agent('mg-slack'), { email: 'a@b.co' });
    await lookup(agent('mg-named'), { email: 'a@b.co' });
    const auth = fetchSpy.mock.calls.map(
      (c: unknown[]) => ((c[1] as RequestInit).headers as Record<string, string>).Authorization,
    );
    expect(auth).toEqual([`Bearer ${TOKEN}-SLACK_BOT_TOKEN`, `Bearer ${TOKEN}-SLACK_BOT_TOKEN_ALPHA`]);
  });

  it('refuses a missing, deleted, bot or app user', async () => {
    slackReplies({ ok: false, error: 'users_not_found' });
    expect(await errText(agent('mg-slack'), { email: 'a@b.co' })).toContain('no active Slack user with that email');
    for (const flag of ['deleted', 'is_bot', 'is_app_user']) {
      slackReplies({ ok: true, user: { id: 'U9', real_name: 'X', [flag]: true } });
      expect(await errText(agent('mg-slack'), { email: 'a@b.co' })).toContain('no active Slack user with that email');
    }
  });

  it('names the missing scope', async () => {
    slackReplies({ ok: false, error: 'missing_scope' });
    expect(await errText(agent('mg-slack'), { email: 'a@b.co' })).toContain('users:read.email');
  });

  it('reports other Slack errors by code', async () => {
    slackReplies({ ok: false, error: 'ratelimited' });
    expect(await errText(agent('mg-slack'), { email: 'a@b.co' })).toContain('Slack lookup failed: ratelimited');
  });

  it('refuses a bad email before any call', async () => {
    for (const email of ['nobody', 'a@@b.co', 'a b@c.co', '@b.co', 'a@', `${'a'.repeat(250)}@b.co`]) {
      expect(await errText(agent('mg-slack'), { email })).toContain('--email must be a single email address');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a chat that is not Slack', async () => {
    expect(await errText(agent('mg-tg'), { email: 'a@b.co' })).toContain('only works from a Slack chat');
    expect(await errText(agent('mg-missing'), { email: 'a@b.co' })).toContain('only works from a Slack chat');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a host caller without --instance and accepts one with it', async () => {
    expect(await errText({ caller: 'host' }, { email: 'a@b.co' })).toContain('--instance');
    slackReplies({ ok: true, user: { id: 'U1', real_name: 'A' } });
    const res = await lookup({ caller: 'host' }, { email: 'a@b.co', instance: 'slack-alpha' });
    expect(res.ok).toBe(true);
    expect(((fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}-SLACK_BOT_TOKEN_ALPHA`,
    );
  });

  it('an agent cannot pick another instance with --instance', async () => {
    slackReplies({ ok: true, user: { id: 'U1', real_name: 'A' } });
    await lookup(agent('mg-slack'), { email: 'a@b.co', instance: 'slack-alpha' });
    expect(((fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}-SLACK_BOT_TOKEN`,
    );
  });

  it('never puts the token in an error', async () => {
    const texts: string[] = [];
    slackReplies({ ok: false, error: `bad ${TOKEN}-SLACK_BOT_TOKEN` });
    texts.push(await errText(agent('mg-slack'), { email: 'a@b.co' }));
    fetchSpy.mockRejectedValue(new Error(`connect failed for ${TOKEN}-SLACK_BOT_TOKEN`));
    texts.push(await errText(agent('mg-slack'), { email: 'a@b.co' }));
    fetchSpy.mockResolvedValue(new Response('not json'));
    texts.push(await errText(agent('mg-slack'), { email: 'a@b.co' }));
    slackReplies({ ok: false, error: 'missing_scope' });
    texts.push(await errText(agent('mg-slack'), { email: 'a@b.co' }));
    vi.mocked(envValue).mockReturnValue(undefined);
    texts.push(await errText(agent('mg-slack'), { email: 'a@b.co' }));
    for (const t of texts) expect(t).not.toContain('SENTINEL');
  });

  it('is allowed at group scope and listed in group-scope help', async () => {
    await ensureContainerConfig('ag-1');
    await updateContainerConfigScalars('ag-1', { cli_scope: 'group' } as never);
    slackReplies({ ok: true, user: { id: 'U1', real_name: 'A' } });
    expect((await lookup(agent('mg-slack'), { email: 'a@b.co' })).ok).toBe(true);
    const help = await dispatch({ id: '2', command: 'help', args: {} }, agent('mg-slack'));
    expect(help.ok && JSON.stringify(help.human ?? help.data)).toContain('slack-users');
  });
});
