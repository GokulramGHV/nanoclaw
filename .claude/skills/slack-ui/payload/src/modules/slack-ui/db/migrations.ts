import { registerMigration } from '../../../db/migrations/index.js';

/**
 * `ui_cards` — one row per posted Slack card. The template is stored as a
 * snapshot (`template_json`) so re-stamping a template never changes live
 * cards, and clicks keep working after a host restart.
 */
registerMigration({
  version: 1,
  name: 'module:slack-ui:create-ui-cards',
  async up(db) {
    await db.exec(`
      CREATE TABLE ui_cards (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        instance       TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        thread_ts      TEXT,
        message_ts     TEXT,
        owner_user_id  TEXT,
        template_name  TEXT NOT NULL,
        template_json  TEXT NOT NULL,
        data_json      TEXT NOT NULL,
        state_json     TEXT NOT NULL DEFAULT '{}',
        locked         INTEGER NOT NULL DEFAULT 0,
        locked_by      TEXT,
        locked_at      TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )
    `);
  },
});
