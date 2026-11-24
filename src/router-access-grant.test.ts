/**
 * registerAccessGrant: a grant admits one sender on one wiring for one event,
 * can only admit, and a throwing grant is no grant. Run through the real routeInbound.
 */
import fs from 'fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-access-grant' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { setMessagingGroupDeniedAt } from './db/messaging-groups.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { registerAccessGrant, routeInbound, setAccessGate, setSenderScopeGate } from './router.js';
import { wakeContainer } from './container-runner.js';
import type { ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-access-grant';
const now = () => new Date().toISOString();
const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

const grant = { fn: (_mgId: string): boolean | Promise<boolean> => false, calls: 0 };

beforeAll(() => {
  // Gates that refuse everyone, so only a grant can admit.
  setAccessGate(() => ({ allowed: false, reason: 'test' }));
  setSenderScopeGate(() => ({ allowed: false, reason: 'test' }));
  registerAccessGrant((_e, _u, mg) => {
    grant.calls++;
    return grant.fn(mg.id);
  });
});

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  registerChannelAdapter('testchat', { factory: () => null, defaults });
  await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  for (const id of ['mg-1', 'mg-2']) {
    await createMessagingGroup({
      id,
      channel_type: 'testchat',
      platform_id: `chan-${id}`,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: `mga-${id}`,
      messaging_group_id: id,
      agent_group_id: 'ag-1',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
  grant.fn = () => false;
  grant.calls = 0;
  vi.mocked(wakeContainer).mockClear();
});
afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const event = (platformId: string) => ({
  channelType: 'testchat',
  platformId,
  threadId: null,
  message: {
    id: `m-${Math.random()}`,
    kind: 'chat' as const,
    content: JSON.stringify({ senderId: 'u1', text: 'hi' }),
    timestamp: now(),
    isMention: true,
    isGroup: true,
  },
});

describe('registerAccessGrant', () => {
  it('no grant: the gates decide, nothing changes', async () => {
    await routeInbound(event('chan-mg-1'));
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('a grant admits only the wiring it names', async () => {
    grant.fn = (mgId) => mgId === 'mg-1';
    await routeInbound(event('chan-mg-1'));
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    await routeInbound(event('chan-mg-2'));
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('a throwing grant (or a rejecting one) admits nobody', async () => {
    grant.fn = () => {
      throw new Error('boom');
    };
    await routeInbound(event('chan-mg-1'));
    grant.fn = () => Promise.reject(new Error('boom'));
    await routeInbound(event('chan-mg-1'));
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('a grant cannot admit on a denied channel, and is never asked', async () => {
    await getMgDeny('mg-1');
    grant.fn = () => true;
    await routeInbound(event('chan-mg-1'));
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('is not consulted when the wiring does not engage', async () => {
    grant.fn = () => true;
    const e = event('chan-mg-1');
    e.message.isMention = false;
    await routeInbound(e);
    expect(grant.calls).toBe(0);
  });
});

/** Deny = no wiring left and the owner's denied mark: the router stops before fan-out. */
async function getMgDeny(id: string): Promise<void> {
  const { getDb } = await import('./db/index.js');
  await getDb().run('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?', id);
  await setMessagingGroupDeniedAt(id, now());
}
