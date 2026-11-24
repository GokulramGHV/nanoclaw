# Remove Slack team access

1. Delete this line from `src/modules/index.ts`:

   ```typescript
   import './slack-team-access/index.js';
   ```

2. Delete the copied files:

   ```bash
   rm -rf src/modules/slack-team-access
   ```

3. Rebuild and restart the host:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```

Once the module is gone, nothing enforces the user-group gate or the Slack Connect refusal any more. Before removing it, decide what happens to the channels it auto-wired. They stay wired to the agent group, with `sender_scope = 'known'` and the sender policy the Slack adapter declared, so the permissions module's usual rules apply again. The module adds no lasting memberships, so nobody keeps access it gave; people can then only be admitted by the owner's sender-approval flow. If a host crash left a row in `slack_team_access_grants`, run the module once more (it sweeps at start) before removing it, or delete the matching agent-group members by hand. To list and detach the auto-wired channels first:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT w.messaging_group_id, mg.platform_id, mg.instance FROM slack_team_access_wired w JOIN messaging_groups mg ON mg.id = w.messaging_group_id"
```

Delete a wiring with `ncl wirings delete`. The `slack_team_access`, `slack_team_access_wired` and `slack_team_access_grants` tables stay in the central database and are harmless; drop them by hand if you want them gone.
