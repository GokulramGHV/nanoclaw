import { getDb } from '../../../db/connection.js';
import type { CardTemplate } from '../template.js';

export interface UiCard {
  id: string;
  agentGroupId: string;
  sessionId: string;
  instance: string;
  channelId: string;
  threadTs: string | null;
  messageTs: string | null;
  ownerUserId: string | null;
  templateName: string;
  template: CardTemplate;
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a caller supplies at insert; the rest is set by `insertCard`. */
export type NewCard = Pick<
  UiCard,
  | 'id'
  | 'agentGroupId'
  | 'sessionId'
  | 'instance'
  | 'channelId'
  | 'threadTs'
  | 'ownerUserId'
  | 'templateName'
  | 'template'
  | 'data'
  | 'state'
>;

interface UiCardRow {
  id: string;
  agent_group_id: string;
  session_id: string;
  instance: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string | null;
  owner_user_id: string | null;
  template_name: string;
  template_json: string;
  data_json: string;
  state_json: string;
  locked: number;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: UiCardRow): UiCard {
  return {
    id: r.id,
    agentGroupId: r.agent_group_id,
    sessionId: r.session_id,
    instance: r.instance,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    messageTs: r.message_ts,
    ownerUserId: r.owner_user_id,
    templateName: r.template_name,
    template: JSON.parse(r.template_json) as CardTemplate,
    data: JSON.parse(r.data_json) as Record<string, unknown>,
    state: JSON.parse(r.state_json) as Record<string, unknown>,
    locked: r.locked === 1,
    lockedBy: r.locked_by,
    lockedAt: r.locked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertCard(row: NewCard): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO ui_cards (
       id, agent_group_id, session_id, instance, channel_id, thread_ts, message_ts, owner_user_id,
       template_name, template_json, data_json, state_json, locked, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`,
    row.id,
    row.agentGroupId,
    row.sessionId,
    row.instance,
    row.channelId,
    row.threadTs,
    row.ownerUserId,
    row.templateName,
    JSON.stringify(row.template),
    JSON.stringify(row.data),
    JSON.stringify(row.state),
    now,
    now,
  );
}

export async function getCard(id: string): Promise<UiCard | undefined> {
  const row = await getDb().get<UiCardRow>('SELECT * FROM ui_cards WHERE id = ?', id);
  return row ? fromRow(row) : undefined;
}

export async function setMessageTs(id: string, ts: string): Promise<void> {
  await getDb().run(
    'UPDATE ui_cards SET message_ts = ?, updated_at = ? WHERE id = ?',
    ts,
    new Date().toISOString(),
    id,
  );
}

export async function updateState(id: string, state: Record<string, unknown>): Promise<void> {
  await getDb().run(
    'UPDATE ui_cards SET state_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(state),
    new Date().toISOString(),
    id,
  );
}

/** Write state only while the card is unlocked; true when a row changed. */
export async function updateStateIfUnlocked(id: string, state: Record<string, unknown>): Promise<boolean> {
  const res = await getDb().run(
    'UPDATE ui_cards SET state_json = ?, updated_at = ? WHERE id = ? AND locked = 0',
    JSON.stringify(state),
    new Date().toISOString(),
    id,
  );
  return res.changes === 1;
}

/** Atomically lock a card for `userId`; true only for the caller that won. */
export async function tryLock(id: string, userId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await getDb().run(
    'UPDATE ui_cards SET locked = 1, locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ? AND locked = 0',
    userId,
    now,
    now,
    id,
  );
  return res.changes === 1;
}

export async function deleteCard(id: string): Promise<void> {
  await getDb().run('DELETE FROM ui_cards WHERE id = ?', id);
}
