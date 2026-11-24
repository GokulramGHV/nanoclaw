/**
 * Configure Slack team access for one Slack instance.
 *
 * Usage:
 *   slack-team-access.ts set <instance> --agent-group <id> [--user-group S...] [--auto-wire]
 *                        [--allow-external] [--release-auto-wired] [--refusal-note "..."] [--external-note "..."]
 *   slack-team-access.ts show <instance>
 *   slack-team-access.ts remove <instance>
 *
 * <instance> is the adapter instance key: `slack` for the default app,
 * `slack-<name>` for a named SLACK_INSTANCES entry. `set` replaces the whole
 * row (flags you leave out go back to their defaults). --auto-wire needs
 * --user-group and is refused without it. The host creates the tables at
 * startup, so run the host once after installing the module first. The host
 * reads the row on each message, so no restart is needed after this.
 */
import { CENTRAL_DB_PATH } from '../../../../src/config.js';
import { closeDb, initDb } from '../../../../src/db/connection.js';
import { getConfig, removeConfig, saveConfig } from '../../../../src/modules/slack-team-access/config.js';

const USAGE =
  'Usage: slack-team-access.ts set <instance> --agent-group <id> [--user-group S...] [--auto-wire] [--allow-external] [--release-auto-wired] [--refusal-note "..."] [--external-note "..."]\n' +
  '       slack-team-access.ts show <instance> | remove <instance>';

const [, , command, instance, ...rest] = process.argv;
if (!['set', 'show', 'remove'].includes(command ?? '') || !instance || instance.startsWith('--')) {
  console.error(USAGE);
  process.exit(2);
}

const flags = new Map<string, string | true>();
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) {
    console.error(`Unexpected argument: ${a}\n${USAGE}`);
    process.exit(2);
  }
  const name = a.slice(2);
  if (['auto-wire', 'allow-external', 'release-auto-wired'].includes(name)) flags.set(name, true);
  else if (['agent-group', 'user-group', 'refusal-note', 'external-note'].includes(name) && rest[i + 1] !== undefined) {
    flags.set(name, rest[++i]);
  } else {
    console.error(`Unknown or incomplete flag: ${a}\n${USAGE}`);
    process.exit(2);
  }
}
const str = (n: string) => (typeof flags.get(n) === 'string' ? (flags.get(n) as string) : undefined);

await initDb(CENTRAL_DB_PATH, { role: 'tool' });
let code = 0;
try {
  if (command === 'set') {
    const agentGroupId = str('agent-group');
    if (!agentGroupId) throw new Error('--agent-group is required');
    await saveConfig({
      instance,
      agentGroupId,
      userGroupId: str('user-group'),
      autoWire: flags.get('auto-wire') === true,
      refuseExternal: flags.get('allow-external') !== true,
      refusalNote: str('refusal-note'),
      externalNote: str('external-note'),
      releaseAutoWired: flags.get('release-auto-wired') === true,
    });
  } else if (command === 'remove') {
    console.log((await removeConfig(instance)) ? `${instance}: team access removed` : `${instance}: no config`);
  }
  if (command !== 'remove') {
    const cfg = await getConfig(instance);
    console.log(cfg ? JSON.stringify(cfg, null, 2) : `${instance}: no config (team access is off)`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  await closeDb();
}
process.exit(code);
