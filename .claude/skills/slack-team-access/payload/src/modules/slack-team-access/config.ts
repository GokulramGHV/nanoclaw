import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';

export const DEFAULT_REFUSAL_NOTE =
  'Sorry, I only work for members of the team user group, so I cannot act on this message.';
export const DEFAULT_EXTERNAL_NOTE =
  'Sorry, I do not work in channels shared with other organizations (Slack Connect), so I cannot act on this message.';

export interface TeamAccessConfig {
  instance: string;
  agent_group_id: string;
  /** Slack user group (subteam) id whose members may engage; null = no group gate. */
  user_group_id: string | null;
  auto_wire: boolean;
  refuse_external: boolean;
  refusal_note: string;
  external_note: string;
}

interface Row {
  instance: string;
  agent_group_id: string;
  user_group_id: string | null;
  auto_wire: number;
  refuse_external: number;
  refusal_note: string | null;
  external_note: string | null;
}

/** The instance's config, or null when it has none (module off for it). Throws on a database error. */
export async function getConfig(instance: string): Promise<TeamAccessConfig | null> {
  const row = await getDb().get<Row>('SELECT * FROM slack_team_access WHERE instance = ?', instance);
  if (!row) return null;
  return {
    instance: row.instance,
    agent_group_id: row.agent_group_id,
    user_group_id: row.user_group_id?.trim() ? row.user_group_id.trim() : null,
    auto_wire: row.auto_wire === 1,
    refuse_external: row.refuse_external !== 0,
    refusal_note: row.refusal_note?.trim() ? row.refusal_note : DEFAULT_REFUSAL_NOTE,
    external_note: row.external_note?.trim() ? row.external_note : DEFAULT_EXTERNAL_NOTE,
  };
}

export interface SaveInput {
  instance: string;
  agentGroupId: string;
  userGroupId?: string | null;
  autoWire?: boolean;
  refuseExternal?: boolean;
  refusalNote?: string | null;
  externalNote?: string | null;
}

const USER_GROUP_ID = /^S[A-Z0-9]{2,}$/;

/** Validate and replace the instance's config. Auto-wire without a user group is refused. */
export async function saveConfig(input: SaveInput): Promise<void> {
  const instance = input.instance.trim();
  if (!instance) throw new Error('An instance name is required');
  if (!(await getAgentGroup(input.agentGroupId))) throw new Error(`Unknown agent group: ${input.agentGroupId}`);
  const userGroup = input.userGroupId?.trim() || null;
  if (userGroup && !USER_GROUP_ID.test(userGroup)) {
    throw new Error(`Not a Slack user group id (expected S...): ${userGroup}`);
  }
  if (input.autoWire && !userGroup) {
    throw new Error('Auto-wire needs a user group: pass the Slack user group id, or leave auto-wire off');
  }
  await getDb().run(
    `INSERT INTO slack_team_access
       (instance, agent_group_id, user_group_id, auto_wire, refuse_external, refusal_note, external_note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance) DO UPDATE SET
       agent_group_id = excluded.agent_group_id, user_group_id = excluded.user_group_id,
       auto_wire = excluded.auto_wire, refuse_external = excluded.refuse_external,
       refusal_note = excluded.refusal_note, external_note = excluded.external_note,
       updated_at = excluded.updated_at`,
    instance,
    input.agentGroupId,
    userGroup,
    input.autoWire ? 1 : 0,
    input.refuseExternal === false ? 0 : 1,
    input.refusalNote?.trim() || null,
    input.externalNote?.trim() || null,
    new Date().toISOString(),
  );
}

/** Delete the instance's config (module off for it). Channels already wired stay wired. */
export async function removeConfig(instance: string): Promise<boolean> {
  const res = await getDb().run('DELETE FROM slack_team_access WHERE instance = ?', instance);
  return res.changes > 0;
}

export async function isAutoWired(messagingGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ messaging_group_id: string }>(
    'SELECT messaging_group_id FROM slack_team_access_wired WHERE messaging_group_id = ?',
    messagingGroupId,
  );
  return row !== undefined;
}
