# Remove Slack thread context

1. Delete this line from `src/modules/index.ts`:

   ```typescript
   import './slack-thread-context/index.js';
   ```

2. Delete the copied files:

   ```bash
   rm -rf src/modules/slack-thread-context
   ```

3. Rebuild and restart the host:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```

The `thread_context_settings` table stays in the central database; nothing reads it once the module is gone, so it is harmless. Drop it by hand if you want it gone. Files already saved under session inboxes (`inbox/thread-*`) stay where they are. Optional `.env` values `SLACK_THREAD_CONTEXT_MAX_MESSAGES` and `SLACK_THREAD_CONTEXT_MAX_FILE_MB` can be deleted.
