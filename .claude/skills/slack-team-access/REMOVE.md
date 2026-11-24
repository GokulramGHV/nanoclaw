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

Once the module is gone, nothing enforces the user-group gate or the Slack Connect refusal any more. Before removing it, decide what happens to the channels it auto-wired. They stay wired to the agent group, with `sender_scope = 'known'` and the sender policy the Slack adapter declared, so the permissions module's usual rules apply again; the people it added to the agent group stay members of it. To list and detach the auto-wired channels first:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT w.messaging_group_id, mg.platform_id, mg.instance FROM slack_team_access_wired w JOIN messaging_groups mg ON mg.id = w.messaging_group_id"
```

Delete a wiring with `ncl wirings delete`. Remove a person's membership with `ncl members remove`. The `slack_team_access` and `slack_team_access_wired` tables stay in the central database and are harmless; drop them by hand if you want them gone.
