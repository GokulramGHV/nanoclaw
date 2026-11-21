# Remove Slack UI cards

1. Delete this line from `src/modules/index.ts`:

   ```typescript
   import './slack-ui/index.js';
   ```

2. Delete this line from `container/agent-runner/src/mcp-tools/index.ts`:

   ```typescript
   import './post-card.js';
   ```

3. Delete the copied files:

   ```bash
   rm -rf src/modules/slack-ui
   rm -f container/agent-runner/src/mcp-tools/post-card.ts \
         container/agent-runner/src/mcp-tools/post-card.test.ts \
         container/agent-runner/src/mcp-tools/post-card.instructions.md \
         container/agent-runner/src/mcp-tools/post-card-registration.test.ts
   ```

4. Rebuild and restart the host:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```

The `ui_cards` table stays in the central database. Nothing reads it once the module is gone, so it is harmless. Card templates under `groups/<folder>/plugins/<plugin>/cards/` belong to the agent groups and are left in place. Cards already posted in Slack stay visible, but their controls no longer work.
