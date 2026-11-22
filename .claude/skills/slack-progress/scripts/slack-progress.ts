/**
 * Switch live Slack progress on or off for one agent group.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/slack-progress/scripts/slack-progress.ts enable|disable|status <agent-group-id>
 *
 * Opens the central DB the same way scripts/q.ts does, so it works with the
 * installed composition. The host creates the progress tables at startup, so
 * run the host once after installing the module first. Restart the group's container after a change so a
 * running session picks up the marker file.
 */
import { CENTRAL_DB_PATH } from '../../../../src/config.js';
import { closeDb, initDb } from '../../../../src/db/connection.js';
import { isEnabled, setEnabled } from '../../../../src/modules/slack-progress/settings.js';

const [, , command, agentGroupId] = process.argv;

if (!['enable', 'disable', 'status'].includes(command ?? '') || !agentGroupId) {
  console.error('Usage: slack-progress.ts enable|disable|status <agent-group-id>');
  process.exit(2);
}

await initDb(CENTRAL_DB_PATH, { role: 'tool' });
let code = 0;
try {
  if (command === 'enable') await setEnabled(agentGroupId, true);
  else if (command === 'disable') await setEnabled(agentGroupId, false);
  console.log(`${agentGroupId}: slack-progress ${(await isEnabled(agentGroupId)) ? 'enabled' : 'disabled'}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  await closeDb();
}
process.exit(code);
