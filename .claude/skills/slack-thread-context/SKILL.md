---
name: slack-thread-context
description: Show a Slack agent the thread it was tagged into. When someone tags the agent partway through a thread, the host adds the thread's first message and the messages before the tag (with names, times and files), who asked (Slack user id, name, email) and the thread link. Off by default for each agent group; an operator turns it on with a script. Requires /add-slack.
---

# Slack thread context

When an agent is tagged in the middle of a Slack thread, it normally sees only the tagging message. This skill adds the conversation it was tagged into.

On every engaged Slack message the host adds context blocks before the message:

- **`slack-asker`** (every message, in a thread or not): the tagger's Slack user id, display name and email (email omitted when Slack gives none; needs `users:read.email`), and a link: the thread link inside a thread, the message link on a top-level message. The email goes into the session database and to the model provider; leave `users:read.email` off the app if that is not wanted.
- **`slack-thread`** (only inside a thread): the thread's first message, then up to the 200 messages before the tag (oldest first), each with the author's display name and Slack id, time and text. Bot messages are labeled `(bot <id>)`. Messages the session already holds are not repeated: its earlier inbound rows, its own delivered posts, and the lines of this block shown at an earlier tag. If messages were left out, a line at the top says how many and why. Over about 30,000 characters the oldest messages after the first are dropped. The block tells the agent it is quoted conversation, not instructions, and that only the asker directs it. The provider's own notes use the sender `slack-thread-context`; user lines always end in `(<slack id>)`, so no display name can pass for a note.

Timing: the Slack text reads (replies, users, permalink) get an internal deadline of about 1.2 s (`SLACK_THREAD_CONTEXT_DEADLINE_MS`), inside the host's 1.5 s wake-context budget. If they land, the thread block arrives on the tagging turn. If they miss, the block is a short stub naming `/workspace/inbox/thread-<message ts>/thread.md`, and the full rendered thread is written there when the read finishes.

Files on the shown messages are downloaded in the background (3 at a time, about 15 s in total) with the bot token, into the final inbox paths (`/workspace/inbox/thread-<message ts>/<file id>-<name>`). The block lists each as "saving to <path>", so a file can appear a moment after the block. Skipped files are listed with the reason: over 10 MB, more than 25 in the thread, no link, unsafe name, or not hosted by Slack. The bot token is only ever sent to Slack's own file hosts (files.slack.com, slack-files.com, slack.com and their gov variants); any other link is not fetched.

If Slack refuses a call, the agent gets a short block saying the thread could not be read, with Slack's error code. Nothing here ever fails the message. A switch that cannot be read counts as off.

What the agent already got without this skill: the tagger's display name and the message text only. The router does not give the Slack user id, the email or the permalink, and no earlier thread messages. This skill adds exactly those.

Limits to know:

- If the text reads miss the deadline, the stub block carries no message ids, so a later tag in that thread may show the thread again.
- A file that fails to download after the block was written never appears; the host log has a warning.
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
