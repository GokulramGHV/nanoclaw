/**
 * Switch Slack thread context on or off for one agent group.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/slack-thread-context/scripts/slack-thread-context.ts enable|disable|status <agent-group-id>
 *
 * The host creates the settings table at startup, so run the host once after
 * installing the module first. The host reads the switch on each engaged
 * message, so no restart is needed after this.
 */
import { CENTRAL_DB_PATH } from '../../../../src/config.js';
import { closeDb, initDb } from '../../../../src/db/connection.js';
import { isEnabled, setEnabled } from '../../../../src/modules/slack-thread-context/settings.js';

const [, , command, agentGroupId] = process.argv;

if (!['enable', 'disable', 'status'].includes(command ?? '') || !agentGroupId) {
  console.error('Usage: slack-thread-context.ts enable|disable|status <agent-group-id>');
  process.exit(2);
}

await initDb(CENTRAL_DB_PATH, { role: 'tool' });
let code = 0;
try {
  if (command === 'enable') await setEnabled(agentGroupId, true);
  else if (command === 'disable') await setEnabled(agentGroupId, false);
  console.log(`${agentGroupId}: slack-thread-context ${(await isEnabled(agentGroupId)) ? 'enabled' : 'disabled'}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  await closeDb();
}
process.exit(code);
