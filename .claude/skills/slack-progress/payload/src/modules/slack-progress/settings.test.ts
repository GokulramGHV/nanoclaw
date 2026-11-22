import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { groupsDir } = vi.hoisted(() => ({
  groupsDir: `${process.env.TMPDIR ?? '/tmp'}/slack-progress-settings-${process.pid}`,
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: groupsDir,
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import './db/migrations.js';
import { isEnabled, setEnabled } from './settings.js';

const marker = path.join(groupsDir, 'demo-folder', '.slack-progress-enabled');

beforeEach(async () => {
  fs.mkdirSync(groupsDir, { recursive: true });
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
  fs.rmSync(groupsDir, { recursive: true, force: true });
});

describe('progress settings', () => {
  it('isEnabled defaults false', async () => {
    expect(await isEnabled('ag-1')).toBe(false);
    expect(await isEnabled('missing')).toBe(false);
  });

  it('setEnabled true writes the marker file in the group folder; false removes it', async () => {
    expect(groupsDir.startsWith(os.tmpdir()) || groupsDir.startsWith('/tmp')).toBe(true);
    await setEnabled('ag-1', true);
    expect(await isEnabled('ag-1')).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);

    await setEnabled('ag-1', false);
    expect(await isEnabled('ag-1')).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects an unknown agent group', async () => {
    await expect(setEnabled('missing', true)).rejects.toThrow(/Unknown agent group/);
  });
});
