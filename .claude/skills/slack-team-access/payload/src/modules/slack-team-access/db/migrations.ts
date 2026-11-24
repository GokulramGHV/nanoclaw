import { registerMigration } from '../../../db/migrations/index.js';

/**
 * Per-Slack-instance team-access config (no row = the module does nothing for
 * that instance), and the channels this module wired itself.
 */
registerMigration({
  version: 1,
  name: 'module:slack-team-access:create-tables',
  async up(db) {
    await db.exec(`
      CREATE TABLE slack_team_access (
        instance        TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL,
        user_group_id   TEXT,
        auto_wire       INTEGER NOT NULL DEFAULT 0,
        refuse_external INTEGER NOT NULL DEFAULT 1,
        refusal_note    TEXT,
        external_note   TEXT,
        updated_at      TEXT NOT NULL
      );
      CREATE TABLE slack_team_access_wired (
        messaging_group_id TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL,
        wiring_id          TEXT NOT NULL,
        created_at         TEXT NOT NULL
      );
      -- Memberships added for the length of one routed message; swept at startup if a crash left any.
      CREATE TABLE slack_team_access_grants (
        user_id        TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_group_id)
      );
    `);
  },
});
