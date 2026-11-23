import { getDb } from '../../../db/connection.js';

export interface PlanRow {
  turnId: string;
  sessionId: string;
  agentGroupId: string;
  instance: string;
  channelId: string;
  threadTs: string | null;
  messageTs: string | null;
  stateJson: string;
  lastDrawnAt: string | null;
  updatedAt: string;
  closed: boolean;
  createdAt: string;
}

export type StreamStatus = 'open' | 'stopped' | 'failed';

export interface StreamRow {
  streamId: string;
  sessionId: string;
  instance: string;
  channelId: string;
  threadTs: string | null;
  streamTs: string | null;
  status: StreamStatus;
  sentText: string;
  /** Slack rate limited an append: no more appends, and the reply is posted in full. */
  held: boolean;
  updatedAt: string;
  createdAt: string;
}

interface PlanDbRow {
  turn_id: string;
  session_id: string;
  agent_group_id: string;
  instance: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string | null;
  state_json: string;
  last_drawn_at: string | null;
  updated_at: string;
  closed: number;
  created_at: string;
}

interface StreamDbRow {
  stream_id: string;
  session_id: string;
  instance: string;
  channel_id: string;
  thread_ts: string | null;
  stream_ts: string | null;
  status: StreamStatus;
  sent_text: string;
  held: number;
  updated_at: string;
  created_at: string;
}

const planFromRow = (r: PlanDbRow): PlanRow => ({
  turnId: r.turn_id,
  sessionId: r.session_id,
  agentGroupId: r.agent_group_id,
  instance: r.instance,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  messageTs: r.message_ts,
  stateJson: r.state_json,
  lastDrawnAt: r.last_drawn_at,
  updatedAt: r.updated_at,
  closed: r.closed === 1,
  createdAt: r.created_at,
});

const streamFromRow = (r: StreamDbRow): StreamRow => ({
  streamId: r.stream_id,
  sessionId: r.session_id,
  instance: r.instance,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  streamTs: r.stream_ts,
  status: r.status,
  sentText: r.sent_text,
  held: r.held === 1,
  updatedAt: r.updated_at,
  createdAt: r.created_at,
});

export async function getPlan(turnId: string): Promise<PlanRow | null> {
  const row = await getDb().get<PlanDbRow>('SELECT * FROM progress_plans WHERE turn_id = ?', turnId);
  return row ? planFromRow(row) : null;
}

/** Insert or replace by turn id. The original `created_at` is kept on replace. */
export async function upsertPlan(row: PlanRow): Promise<void> {
  await getDb().run(
    `INSERT INTO progress_plans (
       turn_id, session_id, agent_group_id, instance, channel_id, thread_ts, message_ts,
       state_json, last_drawn_at, updated_at, closed, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id) DO UPDATE SET
       session_id = excluded.session_id,
       agent_group_id = excluded.agent_group_id,
       instance = excluded.instance,
       channel_id = excluded.channel_id,
       thread_ts = excluded.thread_ts,
       message_ts = excluded.message_ts,
       state_json = excluded.state_json,
       last_drawn_at = excluded.last_drawn_at,
       updated_at = excluded.updated_at,
       closed = excluded.closed`,
    row.turnId,
    row.sessionId,
    row.agentGroupId,
    row.instance,
    row.channelId,
    row.threadTs,
    row.messageTs,
    row.stateJson,
    row.lastDrawnAt,
    row.updatedAt,
    row.closed ? 1 : 0,
    row.createdAt,
  );
}

/** Open plans of one session, oldest first. */
export async function listOpenPlansForSession(sessionId: string): Promise<PlanRow[]> {
  const rows = await getDb().all<PlanDbRow>(
    'SELECT * FROM progress_plans WHERE session_id = ? AND closed = 0 ORDER BY created_at',
    sessionId,
  );
  return rows.map(planFromRow);
}

export async function closePlan(turnId: string): Promise<void> {
  await getDb().run(
    'UPDATE progress_plans SET closed = 1, updated_at = ? WHERE turn_id = ?',
    new Date().toISOString(),
    turnId,
  );
}

export async function getStream(streamId: string): Promise<StreamRow | null> {
  const row = await getDb().get<StreamDbRow>('SELECT * FROM progress_streams WHERE stream_id = ?', streamId);
  return row ? streamFromRow(row) : null;
}

/** Insert or replace by stream id. The original `created_at` is kept on replace. */
export async function upsertStream(row: StreamRow): Promise<void> {
  await getDb().run(
    `INSERT INTO progress_streams (
       stream_id, session_id, instance, channel_id, thread_ts, stream_ts,
       status, sent_text, held, updated_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stream_id) DO UPDATE SET
       session_id = excluded.session_id,
       instance = excluded.instance,
       channel_id = excluded.channel_id,
       thread_ts = excluded.thread_ts,
       stream_ts = excluded.stream_ts,
       status = excluded.status,
       sent_text = excluded.sent_text,
       held = excluded.held,
       updated_at = excluded.updated_at`,
    row.streamId,
    row.sessionId,
    row.instance,
    row.channelId,
    row.threadTs,
    row.streamTs,
    row.status,
    row.sentText,
    row.held ? 1 : 0,
    row.updatedAt,
    row.createdAt,
  );
}

/** Open plans, and open or held streams, last updated before `olderThanIso`. */
export async function listStale(olderThanIso: string): Promise<{ plans: PlanRow[]; streams: StreamRow[] }> {
  const db = getDb();
  const plans = await db.all<PlanDbRow>(
    'SELECT * FROM progress_plans WHERE closed = 0 AND updated_at < ? ORDER BY updated_at',
    olderThanIso,
  );
  const streams = await db.all<StreamDbRow>(
    "SELECT * FROM progress_streams WHERE (status = 'open' OR (status = 'failed' AND held = 1)) AND updated_at < ? ORDER BY updated_at",
    olderThanIso,
  );
  return { plans: plans.map(planFromRow), streams: streams.map(streamFromRow) };
}
