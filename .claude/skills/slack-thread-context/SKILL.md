---
name: slack-thread-context
description: Show a Slack agent the thread it was tagged into. When someone tags the agent partway through a thread, the host adds the thread's first message and the messages before the tag (with names, times and files), who asked (Slack user id, name, email) and the thread link. Off by default for each agent group; an operator turns it on with a script. Requires /add-slack.
---

# Slack thread context

When an agent is tagged in the middle of a Slack thread, it normally sees only the tagging message. This skill adds the conversation it was tagged into.

On each engaged Slack message that sits inside a thread (the thread's timestamp differs from the message's own), the host adds two context blocks before the message:

- **`slack-thread`**: the thread's first message, then up to the 200 messages before the tag (oldest first), each with the author's display name, time and text. Bot messages are labeled `(bot)`. Messages the session already holds (its earlier inbound rows, and its own delivered posts) are not repeated. If messages were left out, a line at the top of the block says how many and why. Over about 30,000 characters the oldest messages after the first are dropped.
- **`slack-asker`**: the tagger's Slack user id, display name and email (omitted when Slack gives none), and the thread's permalink.

Files on the shown messages are downloaded with the bot token into the session inbox (`/workspace/inbox/thread-<message ts>/<file id>-<name>`), the same place normal attachments go, and each message line names the path. Files over 10 MB, or beyond 25 in one thread, are listed as skipped with the reason.

If Slack refuses a call, the agent gets a short block saying the thread could not be read, with Slack's error code. Nothing here ever fails the message.

What the agent already got without this skill: the tagger's display name and the message text only. The router does not give the Slack user id, the email or the permalink, and no earlier thread messages. This skill adds exactly those.

Limits to know:

- The host waits at most 1.5 seconds for all wake context together (`WAKE_CONTEXT_BUDGET_MS` in `src/wake-context.ts`). A long thread with many authors or files can miss that. A block that misses it is still written, but reaches the agent with its next message, not this one.
- Thread timestamps in the block show in the container's timezone, like every other message.

## Prerequisites

- Slack installed with `/add-slack`.
- The wake-context seam in `src/wake-context.ts`.
- Bot scopes, all of them: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `files:read`, `users:read`, `users:read.email`. Without `users:read.email` the email is left out; without the history scope for a conversation type the block says the thread could not be read; without `files:read` files are listed as skipped. After adding scopes, reinstall the Slack app and update the bot token.
- The bot must be a member of the channel (or in the DM) to read its threads.

Check the code prerequisites:

```nc:run effect:check
test -f src/channels/slack-lib.ts || { echo "slack-thread-context needs Slack: run /add-slack first" >&2; exit 1; }
test -f src/wake-context.ts || { echo "slack-thread-context needs src/wake-context.ts" >&2; exit 1; }
```

## Install

### Copy the files

```nc:copy
payload/src/modules/slack-thread-context/db/migrations.ts -> src/modules/slack-thread-context/db/migrations.ts
payload/src/modules/slack-thread-context/index.ts -> src/modules/slack-thread-context/index.ts
payload/src/modules/slack-thread-context/registration.test.ts -> src/modules/slack-thread-context/registration.test.ts
payload/src/modules/slack-thread-context/settings.test.ts -> src/modules/slack-thread-context/settings.test.ts
payload/src/modules/slack-thread-context/settings.ts -> src/modules/slack-thread-context/settings.ts
payload/src/modules/slack-thread-context/slack-api.ts -> src/modules/slack-thread-context/slack-api.ts
payload/src/modules/slack-thread-context/wake.test.ts -> src/modules/slack-thread-context/wake.test.ts
payload/src/modules/slack-thread-context/wake.ts -> src/modules/slack-thread-context/wake.ts
```

### Register the host module

Add this line at the end of `src/modules/index.ts`. Importing the module creates the settings table and registers the wake-context provider:

```nc:append to:src/modules/index.ts
import './slack-thread-context/index.js';
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/modules/slack-thread-context
```

## Turn it on

Start the host once with this skill applied, so the migration creates the settings table: `bash setup/lib/restart.sh`. The operator script does not run migrations, so run it only after that.

Switch it on for one agent group:

```bash
pnpm exec tsx .claude/skills/slack-thread-context/scripts/slack-thread-context.ts enable <agent-group-id>
```

Other commands: `disable <agent-group-id>` and `status <agent-group-id>`. The host reads the switch on each engaged message, so no restart is needed.

Optional `.env` values (read on each message): `SLACK_THREAD_CONTEXT_MAX_MESSAGES` (default 200) and `SLACK_THREAD_CONTEXT_MAX_FILE_MB` (default 10).

## Troubleshooting

- The agent sees "could not be read (slack conversations.replies failed: missing_scope)": add the history scopes above and reinstall the app.
- `not_in_channel`: invite the bot to the channel.
- No thread context at all: the group is off (`status`), the message is not inside a thread, or the host was not restarted after install.
- The block shows up one message late: the wake-context budget was missed; see Limits above.
