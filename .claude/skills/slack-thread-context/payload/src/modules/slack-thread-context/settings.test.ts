import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import './db/migrations.js';
import { isEnabled, setEnabled } from './settings.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Demo',
    folder: 'demo-folder',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('thread context settings', () => {
  it('is off by default', async () => {
    expect(await isEnabled('ag-1')).toBe(false);
    expect(await isEnabled('missing')).toBe(false);
  });

  it('switches on and off', async () => {
    await setEnabled('ag-1', true);
    expect(await isEnabled('ag-1')).toBe(true);
    await setEnabled('ag-1', false);
    expect(await isEnabled('ag-1')).toBe(false);
  });

  it('rejects an unknown agent group', async () => {
    await expect(setEnabled('missing', true)).rejects.toThrow(/Unknown agent group/);
  });
});
