import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';

/** Thread context is off unless a group has been switched on. */
export async function isEnabled(agentGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ enabled: number }>(
    'SELECT enabled FROM thread_context_settings WHERE agent_group_id = ?',
    agentGroupId,
  );
  return row?.enabled === 1;
}

export async function setEnabled(agentGroupId: string, on: boolean): Promise<void> {
  if (!(await getAgentGroup(agentGroupId))) throw new Error(`Unknown agent group: ${agentGroupId}`);
  await getDb().run(
    `INSERT INTO thread_context_settings (agent_group_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_group_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    agentGroupId,
    on ? 1 : 0,
    new Date().toISOString(),
  );
}
