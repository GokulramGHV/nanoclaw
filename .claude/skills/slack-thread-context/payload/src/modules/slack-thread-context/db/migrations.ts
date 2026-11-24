import { registerMigration } from '../../../db/migrations/index.js';

/** A per-agent-group on/off switch for Slack thread context. */
registerMigration({
  version: 1,
  name: 'module:slack-thread-context:create-settings',
  async up(db) {
    await db.exec(`
      CREATE TABLE thread_context_settings (
        agent_group_id TEXT PRIMARY KEY,
        enabled        INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL
      );
    `);
  },
});
