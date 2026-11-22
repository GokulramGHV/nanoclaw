import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';

/** The container reads this file at /workspace/agent/.slack-progress-enabled. */
export const MARKER_FILE = '.slack-progress-enabled';

/** Progress is off unless a group has been switched on. */
export async function isEnabled(agentGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ enabled: number }>(
    'SELECT enabled FROM progress_settings WHERE agent_group_id = ?',
    agentGroupId,
  );
  return row?.enabled === 1;
}

/** Store the switch and mirror it as a marker file in the group folder. */
export async function setEnabled(agentGroupId: string, on: boolean): Promise<void> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Unknown agent group: ${agentGroupId}`);
  await getDb().run(
    `INSERT INTO progress_settings (agent_group_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_group_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    agentGroupId,
    on ? 1 : 0,
    new Date().toISOString(),
  );
  const marker = path.join(GROUPS_DIR, group.folder, MARKER_FILE);
  if (on) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'enabled\n');
  } else {
    fs.rmSync(marker, { force: true });
  }
}
