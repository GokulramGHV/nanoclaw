import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import './db/migrations.js';
import { DEFAULT_EXTERNAL_NOTE, DEFAULT_REFUSAL_NOTE, getConfig, removeConfig, saveConfig } from './config.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Demo',
    folder: 'demo',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});
afterEach(async () => {
  await closeDb();
});

describe('team access config', () => {
  it('is off (no row) by default', async () => {
    expect(await getConfig('slack-x')).toBeNull();
  });

  it('saves with defaults: external refused, notes defaulted, auto-wire off', async () => {
    await saveConfig({ instance: 'slack-x', agentGroupId: 'ag-1', userGroupId: 'S0ABC123' });
    expect(await getConfig('slack-x')).toEqual({
      instance: 'slack-x',
      agent_group_id: 'ag-1',
      user_group_id: 'S0ABC123',
      auto_wire: false,
      refuse_external: true,
      refusal_note: DEFAULT_REFUSAL_NOTE,
      external_note: DEFAULT_EXTERNAL_NOTE,
    });
  });

  it('refuses auto-wire without a user group', async () => {
    await expect(saveConfig({ instance: 'slack-x', agentGroupId: 'ag-1', autoWire: true })).rejects.toThrow(
      /user group/,
    );
    await expect(
      saveConfig({ instance: 'slack-x', agentGroupId: 'ag-1', autoWire: true, userGroupId: '  ' }),
    ).rejects.toThrow(/user group/);
    expect(await getConfig('slack-x')).toBeNull();
  });

  it('refuses an unknown agent group and a malformed user group id', async () => {
    await expect(saveConfig({ instance: 'slack-x', agentGroupId: 'nope', userGroupId: 'S0ABC123' })).rejects.toThrow(
      /Unknown agent group/,
    );
    await expect(saveConfig({ instance: 'slack-x', agentGroupId: 'ag-1', userGroupId: 'team' })).rejects.toThrow(
      /user group id/,
    );
  });

  it('keeps custom notes, replaces the row on a second save, and removes', async () => {
    await saveConfig({
      instance: 'slack-x',
      agentGroupId: 'ag-1',
      userGroupId: 'S0ABC123',
      autoWire: true,
      refuseExternal: false,
      refusalNote: 'No.',
    });
    expect(await getConfig('slack-x')).toMatchObject({ auto_wire: true, refuse_external: false, refusal_note: 'No.' });
    await saveConfig({ instance: 'slack-x', agentGroupId: 'ag-1', userGroupId: 'S0ABC123' });
    expect(await getConfig('slack-x')).toMatchObject({
      auto_wire: false,
      refuse_external: true,
      refusal_note: DEFAULT_REFUSAL_NOTE,
    });
    expect(await removeConfig('slack-x')).toBe(true);
    expect(await getConfig('slack-x')).toBeNull();
  });
});
