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
  /** Let the agent group change although channels were auto-wired to the old one (they become hand-wired). */
  releaseAutoWired?: boolean;
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
  const existing = await getDb().get<{ agent_group_id: string }>(
    'SELECT agent_group_id FROM slack_team_access WHERE instance = ?',
    instance,
  );
  if (existing && existing.agent_group_id !== input.agentGroupId) {
    const live = await autoWiredOf(instance, existing.agent_group_id);
    if (live.length > 0 && !input.releaseAutoWired) {
      throw new Error(
        `${live.length} channel(s) on ${instance} were auto-wired to ${existing.agent_group_id} and would lose the user-group gate. ` +
          'Delete their wirings, or pass --release-auto-wired to keep them wired by hand (the owner then gates them).',
      );
    }
    for (const id of live) await getDb().run('DELETE FROM slack_team_access_wired WHERE messaging_group_id = ?', id);
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

/** Messaging groups on the instance whose auto-wired wiring to this agent group still exists. */
async function autoWiredOf(instance: string, agentGroupId: string): Promise<string[]> {
  const rows = await getDb().all<{ messaging_group_id: string }>(
    `SELECT w.messaging_group_id FROM slack_team_access_wired w
       JOIN messaging_groups mg ON mg.id = w.messaging_group_id
       JOIN messaging_group_agents mga ON mga.id = w.wiring_id AND mga.messaging_group_id = w.messaging_group_id
      WHERE mg.instance = ? AND w.agent_group_id = ? AND mga.agent_group_id = w.agent_group_id`,
    instance,
    agentGroupId,
  );
  return rows.map((r) => r.messaging_group_id);
}

/** Whether this channel's wiring to the agent group is the one this module created (and still exists). */
export async function isAutoWired(messagingGroupId: string, agentGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ n: number }>(
    `SELECT 1 AS n FROM slack_team_access_wired w
       JOIN messaging_group_agents mga ON mga.id = w.wiring_id
      WHERE w.messaging_group_id = ? AND w.agent_group_id = ?
        AND mga.messaging_group_id = w.messaging_group_id AND mga.agent_group_id = w.agent_group_id`,
    messagingGroupId,
    agentGroupId,
  );
  return row !== undefined;
}
