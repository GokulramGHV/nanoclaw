import { registerMigration } from '../../../db/migrations/index.js';

/**
 * Tables for live Slack progress: one plan message per turn, one text
 * stream per reply, and a per-agent-group on/off switch.
 */
registerMigration({
  version: 1,
  name: 'module:slack-progress:create-tables',
  async up(db) {
    await db.exec(`
      CREATE TABLE progress_plans (
        turn_id        TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        instance       TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        thread_ts      TEXT,
        message_ts     TEXT,
        state_json     TEXT NOT NULL DEFAULT '{}',
        last_drawn_at  TEXT,
        updated_at     TEXT NOT NULL,
        closed         INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE progress_streams (
        stream_id  TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        instance   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts  TEXT,
        stream_ts  TEXT,
        status     TEXT NOT NULL CHECK (status IN ('open', 'stopped', 'failed')),
        sent_text  TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE progress_settings (
        agent_group_id TEXT PRIMARY KEY,
        enabled        INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL
      );
    `);
  },
});

/** A stream held because Slack rate limited an append: its final text is posted in full instead. */
registerMigration({
  version: 2,
  name: 'module:slack-progress:stream-held',
  async up(db) {
    await db.exec('ALTER TABLE progress_streams ADD COLUMN held INTEGER NOT NULL DEFAULT 0;');
  },
});
