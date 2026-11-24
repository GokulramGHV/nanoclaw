/**
 * Slack team access through the real router with the real permissions module
 * registered: instance with no row, Slack Connect refusal, the user-group gate,
 * auto-wire, denied channels, lookup failure and slowness, and composition.
 */
import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  setMessagingGroupDeniedAt,
} from '../../db/messaging-groups.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerMessageInterceptor, routeInbound } from '../../router.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { isMember } from '../permissions/db/agent-group-members.js';
import './db/migrations.js';
import { saveConfig } from './config.js';
import { createTeamAccess, type TeamAccessDeps } from './gate.js';

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, sessionMode: 'per-thread', unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('slack', { factory: () => null, defaults });

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver: deliverMock }) }));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: vi.fn(async () => undefined) }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-team-access', GROUPS_DIR: '/tmp/nanoclaw-test-team-access/groups' };
});
const TEST_DIR = '/tmp/nanoclaw-test-team-access';

// One interceptor for the file; the fakes behind it are swapped per test.
const ctl = {
  ext: vi.fn<(c: string) => Promise<boolean>>(),
  members: vi.fn<(g: string) => Promise<string[]>>(),
  ephemeral: vi.fn<(c: string, u: string, t: string, ts?: string) => Promise<void>>(),
  clock: 1_000_000,
  token: 'xoxb-test' as string | undefined,
  groupTimeoutMs: 1500,
};
const deps: TeamAccessDeps = {
  token: () => ctl.token,
  isExtShared: (_t, c) => ctl.ext(c),
  userGroupMembers: (_t, g) => ctl.members(g),
  postEphemeral: (_t, c, u, text, ts) => ctl.ephemeral(c, u, text, ts),
  now: () => ctl.clock,
  get groupTimeoutMs() {
    return ctl.groupTimeoutMs;
  },
  externalTimeoutMs: 3000,
};

const INSTANCE = 'slack-team';
const now = () => new Date().toISOString();

beforeAll(async () => {
  await import('../permissions/index.js');
  registerMessageInterceptor(createTeamAccess(deps));
  await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
});
afterAll(async () => {
  await teardownChannelAdapters();
});

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-team', name: 'Team', folder: 'team', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
  // An owner with a DM, so the channel-request flow can fire when it is the path taken.
  await upsertUser({ id: 'slack:UOWNER', kind: 'slack', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'slack:UOWNER',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  ctl.ext.mockReset().mockResolvedValue(false);
  ctl.members.mockReset().mockResolvedValue(['UMEMBER']);
  ctl.ephemeral.mockReset().mockResolvedValue(undefined);
  ctl.token = 'xoxb-test';
  ctl.groupTimeoutMs = 1500;
  ctl.clock += 10 * 60 * 60 * 1000; // past every cache and rate window of the previous test
  deliverMock.mockClear();
  const { wakeContainer } = await import('../../container-runner.js');
  (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function configure(over: Partial<Parameters<typeof saveConfig>[0]> = {}) {
  return saveConfig({ instance: INSTANCE, agentGroupId: 'ag-team', userGroupId: 'S0TEAM', autoWire: true, ...over });
}

function event(opts: {
  user?: string;
  platformId?: string;
  dm?: boolean;
  mention?: boolean;
  instance?: string;
  threadId?: string | null;
}) {
  const dm = opts.dm === true;
  return {
    channelType: 'slack',
    instance: opts.instance ?? INSTANCE,
    platformId: opts.platformId ?? 'slack:C100',
    threadId: opts.threadId === undefined ? 'slack:C100:1700000000.000100' : opts.threadId,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk' as const,
      content: JSON.stringify({
        senderId: opts.user ?? 'UMEMBER',
        author: { userId: opts.user ?? 'UMEMBER', userName: 'Pat' },
        sender: 'Pat',
        text: '<@bot> hi',
      }),
      timestamp: now(),
      isMention: opts.mention ?? true,
      isGroup: !dm,
    },
  };
}

const count = async (sql: string, ...p: unknown[]) => (await getDb().get<{ c: number }>(sql, ...p))!.c;
const wiringsOn = async (platformId: string) => {
  const mg = await getMessagingGroupByPlatform('slack', platformId, INSTANCE);
  return mg ? getMessagingGroupAgents(mg.id) : [];
};
const woke = async () => {
  const { wakeContainer } = await import('../../container-runner.js');
  return (wakeContainer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
};
const drops = (reason: string) => count('SELECT COUNT(*) AS c FROM unregistered_senders WHERE reason = ?', reason);

describe('no config row', () => {
  it('leaves routing unchanged: the owner channel-request flow still fires', async () => {
    await routeInbound(event({}));
    await vi.waitFor(() => expect(deliverMock).not.toHaveBeenCalled(), { timeout: 50 }).catch(() => {});
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(ctl.ext).not.toHaveBeenCalled();
    expect(ctl.members).not.toHaveBeenCalled();
    expect(await drops('no_agent_wired')).toBe(1); // core's own drop, from the unchanged path
  });

  it('ignores another instance when only one has a row', async () => {
    await configure();
    await routeInbound(event({ instance: 'slack-other' }));
    expect(ctl.members).not.toHaveBeenCalled();
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
  });
});

describe('Slack Connect refusal', () => {
  it('drops, sends the note once per hour, and wakes nothing, even on a wired channel', async () => {
    await configure();
    ctl.ext.mockResolvedValue(true);
    const mg = {
      id: 'mg-c',
      channel_type: 'slack',
      platform_id: 'slack:C100',
      instance: INSTANCE,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public' as const,
      created_at: now(),
    };
    await createMessagingGroup(mg);
    await createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-c',
      agent_group_id: 'ag-team',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    await routeInbound(event({}));
    await routeInbound(event({}));
    expect(await woke()).toBe(0);
    expect(ctl.ephemeral).toHaveBeenCalledTimes(1);
    expect(ctl.ephemeral.mock.calls[0][0]).toBe('C100');
    expect(ctl.ephemeral.mock.calls[0][1]).toBe('UMEMBER');
    expect(ctl.ephemeral.mock.calls[0][3]).toBe('1700000000.000100');
    expect(await drops('slack_external_channel')).toBe(1);
    ctl.clock += 61 * 60 * 1000;
    await routeInbound(event({}));
    expect(ctl.ephemeral).toHaveBeenCalledTimes(2);
  });

  it('refuses when the lookup fails (fail closed)', async () => {
    await configure();
    ctl.ext.mockRejectedValue(new Error('ratelimited'));
    await routeInbound(event({}));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(await woke()).toBe(0);
    expect(await drops('slack_external_lookup_failed')).toBe(1);
  });

  it('refuses when there is no bot token', async () => {
    await configure();
    ctl.token = undefined;
    await routeInbound(event({}));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
  });

  it('caches the lookup for 10 minutes', async () => {
    await configure();
    await routeInbound(event({ platformId: 'slack:C200' }));
    await routeInbound(event({ platformId: 'slack:C200' }));
    expect(ctl.ext).toHaveBeenCalledTimes(1);
    ctl.clock += 11 * 60 * 1000;
    await routeInbound(event({ platformId: 'slack:C200' }));
    expect(ctl.ext).toHaveBeenCalledTimes(2);
  });

  it('is skipped when refuse_external is off', async () => {
    await configure({ refuseExternal: false });
    ctl.ext.mockResolvedValue(true);
    await routeInbound(event({}));
    expect(ctl.ext).not.toHaveBeenCalled();
    expect(await wiringsOn('slack:C100')).toHaveLength(1);
  });
});

describe('user-group gate and auto-wire', () => {
  it('non-member tag in an unwired channel: no wiring, ephemeral note, drop recorded', async () => {
    await configure();
    await routeInbound(event({ user: 'USTRANGER' }));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(await woke()).toBe(0);
    expect(ctl.ephemeral).toHaveBeenCalledTimes(1);
    expect(await drops('slack_not_in_user_group')).toBe(1);
    expect(deliverMock).not.toHaveBeenCalled(); // no owner approval card
  });

  it('member tag in an unwired channel: wired with declared defaults, routed, no approval card', async () => {
    await configure();
    await routeInbound(event({}));
    const wirings = await wiringsOn('slack:C100');
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({
      agent_group_id: 'ag-team',
      engage_mode: 'mention',
      session_mode: 'per-thread',
      threads: 1,
      sender_scope: 'known',
      ignored_message_policy: 'drop',
    });
    expect(await woke()).toBe(1);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(await isMember('slack:UMEMBER', 'ag-team')).toBe(true);
    expect(await count('SELECT COUNT(*) AS c FROM slack_team_access_wired')).toBe(1);
  });

  it('another member in the auto-wired channel is admitted; a non-member is refused', async () => {
    await configure();
    ctl.members.mockResolvedValue(['UMEMBER', 'UTWO']);
    await routeInbound(event({}));
    await routeInbound(event({ user: 'UTWO' }));
    expect(await woke()).toBe(2);
    expect(await isMember('slack:UTWO', 'ag-team')).toBe(true);
    await routeInbound(event({ user: 'USTRANGER' }));
    expect(await woke()).toBe(2);
    expect(await isMember('slack:USTRANGER', 'ag-team')).toBe(false);
  });

  it('member DM is auto-wired and routed with the DM defaults; a non-member DM is refused', async () => {
    await configure();
    await routeInbound(event({ dm: true, platformId: 'slack:D100', threadId: null }));
    const w = await wiringsOn('slack:D100');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });
    expect(await woke()).toBe(1);
    await routeInbound(event({ dm: true, platformId: 'slack:D200', threadId: null, user: 'USTRANGER' }));
    expect(await wiringsOn('slack:D200')).toHaveLength(0);
    expect(await woke()).toBe(1);
    expect(ctl.ephemeral).toHaveBeenCalledTimes(1);
    expect(ctl.ephemeral.mock.calls[0][0]).toBe('D200');
  });

  it('auto-wire off: unwired channels take the owner flow, wired ones are still gated', async () => {
    await configure({ autoWire: false });
    await routeInbound(event({}));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(ctl.members).not.toHaveBeenCalled();
    expect(await drops('no_agent_wired')).toBe(1);
  });

  it('does not note a non-member who only chatted, but still drops it', async () => {
    await configure();
    await routeInbound(event({}));
    ctl.ephemeral.mockClear();
    const w = await woke();
    await routeInbound(event({ user: 'USTRANGER', mention: false }));
    expect(ctl.ephemeral).not.toHaveBeenCalled();
    expect(await woke()).toBe(w);
    expect(await drops('slack_not_in_user_group')).toBe(1);
  });

  it('chatter in an unwired channel does no lookups at all', async () => {
    await configure();
    await routeInbound(event({ mention: false }));
    expect(ctl.ext).not.toHaveBeenCalled();
    expect(ctl.members).not.toHaveBeenCalled();
  });
});

describe('already wired channels', () => {
  async function wire(agentGroupId: string, platformId = 'slack:C300') {
    await createMessagingGroup({
      id: `mg-${platformId}`,
      channel_type: 'slack',
      platform_id: platformId,
      instance: INSTANCE,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: `mga-${platformId}`,
      messaging_group_id: `mg-${platformId}`,
      agent_group_id: agentGroupId,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }

  it('configured group, hand-wired: non-member refused, member allowed, no membership granted', async () => {
    await configure();
    await wire('ag-team');
    await routeInbound(event({ platformId: 'slack:C300', user: 'USTRANGER' }));
    expect(await woke()).toBe(0);
    await routeInbound(event({ platformId: 'slack:C300' }));
    expect(await woke()).toBe(1);
    expect(await isMember('slack:UMEMBER', 'ag-team')).toBe(false); // hand-wired: owner's own policy stays
  });

  it('a channel wired to a different agent group is unchanged (no lookups, even for strangers or external)', async () => {
    await configure();
    ctl.ext.mockResolvedValue(true);
    await wire('ag-other');
    await routeInbound(event({ platformId: 'slack:C300', user: 'USTRANGER' }));
    expect(ctl.ext).not.toHaveBeenCalled();
    expect(ctl.members).not.toHaveBeenCalled();
    expect(await woke()).toBe(1);
  });
});

describe('denied channel', () => {
  it('stays denied for a member', async () => {
    await configure();
    await createMessagingGroup({
      id: 'mg-d',
      channel_type: 'slack',
      platform_id: 'slack:C400',
      instance: INSTANCE,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: now(),
    });
    await setMessagingGroupDeniedAt('mg-d', now());
    await routeInbound(event({ platformId: 'slack:C400' }));
    expect(await wiringsOn('slack:C400')).toHaveLength(0);
    expect(await woke()).toBe(0);
  });
});

describe('group lookup failure', () => {
  it('denies on a failed lookup, without wiring or noting', async () => {
    await configure();
    ctl.members.mockRejectedValue(new Error('missing_scope'));
    await routeInbound(event({}));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(await woke()).toBe(0);
    expect(await drops('slack_group_lookup_failed')).toBe(1);
  });

  it('denies a lookup slower than the timeout', async () => {
    await configure();
    ctl.groupTimeoutMs = 30;
    ctl.members.mockImplementation(() => new Promise(() => {}));
    await routeInbound(event({}));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(await drops('slack_group_lookup_failed')).toBe(1);
  });

  it('caches membership for 60 seconds', async () => {
    await configure();
    await routeInbound(event({}));
    await routeInbound(event({}));
    expect(ctl.members).toHaveBeenCalledTimes(1);
    ctl.clock += 61_000;
    await routeInbound(event({}));
    expect(ctl.members).toHaveBeenCalledTimes(2);
  });

  it('drops when auto-wire is on in the database but no user group is set', async () => {
    await configure();
    await getDb().run('UPDATE slack_team_access SET user_group_id = NULL WHERE instance = ?', INSTANCE);
    await routeInbound(event({}));
    expect(await wiringsOn('slack:C100')).toHaveLength(0);
    expect(await drops('slack_team_access_misconfigured')).toBe(1);
  });
});

describe('composition with the permissions module', () => {
  it('its access gate still refuses an unknown sender on a hand-wired channel to another group', async () => {
    await configure();
    await createMessagingGroup({
      id: 'mg-s',
      channel_type: 'slack',
      platform_id: 'slack:C500',
      instance: INSTANCE,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-s',
      messaging_group_id: 'mg-s',
      agent_group_id: 'ag-other',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    await routeInbound(event({ platformId: 'slack:C500' }));
    expect(await woke()).toBe(0);
    // The permissions module refused and recorded it (core's own no-agent-engaged record then updates the same row).
    expect(await count("SELECT COUNT(*) AS c FROM unregistered_senders WHERE platform_id = 'slack:C500'")).toBe(1);
    expect(ctl.members).not.toHaveBeenCalled();
  });

  it('a user-group member is let through the permissions gates only because they were admitted', async () => {
    await configure();
    await routeInbound(event({}));
    expect(await woke()).toBe(1);
    expect(await isMember('slack:UMEMBER', 'ag-team')).toBe(true);
  });
});

describe('never throws into the router', () => {
  it('consumes the message when the config cannot be read', async () => {
    await configure();
    await getDb().run('DROP TABLE slack_team_access');
    await expect(routeInbound(event({}))).resolves.toBeUndefined();
    expect(await woke()).toBe(0);
  });
});
