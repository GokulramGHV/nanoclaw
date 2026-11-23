# Remove Slack UI cards

1. Delete this line from `src/modules/index.ts`:

   ```typescript
   import './slack-ui/index.js';
   ```

2. Delete these lines from `container/agent-runner/src/mcp-tools/index.ts`:

   ```typescript
   import './post-card.js';
   import './ask.js';
   ```

3. Delete the copied files:

   ```bash
   rm -rf src/modules/slack-ui
   rm -f container/agent-runner/src/mcp-tools/post-card.ts \
         container/agent-runner/src/mcp-tools/post-card.test.ts \
         container/agent-runner/src/mcp-tools/post-card.instructions.md \
         container/agent-runner/src/mcp-tools/post-card-registration.test.ts \
         container/agent-runner/src/mcp-tools/ask.ts \
         container/agent-runner/src/mcp-tools/ask.test.ts \
         container/agent-runner/src/mcp-tools/ask.instructions.md \
         container/agent-runner/src/mcp-tools/ask-registration.test.ts
   ```

4. Uninstall the dependencies:

   ```bash
   pnpm remove slack-ui-kit zod
   ```

   The `zod` pin in `.github/skill-pins/` comes from this skill's `SKILL.md`, so it stays while the skill folder exists. It goes away when the skill folder is deleted and the pins are regenerated (`pnpm run skill-pins:generate`).

5. Rebuild and restart the host:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```

The `ui_kit_cards` table stays in the central database, and so does `ui_cards`, an old unused table from the earlier slack-ui that a fresh install still creates. Drop either by hand if you want them gone. Nothing reads it once the module is gone, so it is harmless. Card templates under `groups/<folder>/plugins/<plugin>/cards/` belong to the agent groups and are left in place. Cards already posted in Slack stay visible, but their controls no longer work. In Slack chats the agent goes back to `ask_user_question`, because `ask` is no longer registered and nothing hides the core tool.
