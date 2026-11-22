---
name: slack-progress
description: Show live progress in Slack chats. While an agent works, the host keeps one plan message that follows the agent's task list and tool use, and it streams the agent's text replies into the thread as they are written. Off by default for each agent group; an operator turns it on with a script. Use when people want to see what an agent is doing instead of waiting for one final reply. Requires /add-slack.
---

# Slack progress

This skill adds progress in chat for Slack agents.

- **Plan message.** The container tracks the agent's work and writes progress rows. The host turns them into one progress message per turn and edits it in place. While the agent works, the live steps are shown as open task cards under a short title line, with steps not started yet listed after them as "Next:". When the turn ends, the message collapses into a plan summary. The steps follow the agent's task list (TodoWrite, or TaskCreate and TaskUpdate). A turn's plan shows the steps created or updated in that turn. It appears at once when the agent first writes a task list, or after 5 seconds of work once the agent has made a tool call. A plain answer with no tools and no task list gets no plan.
- **Streamed replies.** The agent's text is sent to Slack in batches about every half second, using Slack's streaming methods. The reply grows in the thread as it is written.
- **Status line.** While a turn's plan is open, the line under the thread (where Slack shows "Typing...") reads "is working: <what the agent is doing>". The host refreshes it every 8 seconds and pauses the generic typing refresher so it is not overwritten. It is cleared when the turn ends or the plan is closed. It is shown only in the session's own chat, in a thread, and never in `SLACK_A2A_ROOMS` channels.
- **Closing summary.** When the turn ends, the message is redrawn as a collapsed plan summary. If Slack refuses that, it is redrawn as plain text, so it never stays in the working state.
- **No lost replies.** If the stream never started, or fails before any text is sent, the host declines and the normal delivery posts the full text. If a stream fails after text was already sent, the partial message stays in the thread and ends with "_Reply posted below._". The full reply then appears as a second message. The same happens when a reply contains a bare `@name` mention (the reply streams to the end, then it gets the note and the whole reply is posted normally) and when the streamed text does not match the final reply.
- **No narration.** On each engaged message in an enabled Slack chat, the agent is told its progress is already shown live, so it should not report step progress in chat.
- **Quiet when idle.** A host sweep closes plans and streams that have been silent for 2 minutes once the session's container is gone.

Streaming is used only when all of these hold:

- the reply goes to the session's own Slack chat
- the reply is in a thread
- the waking messages come from one human sender (not a bot, a task, an on-wake message or several senders)
- the channel is not listed in `SLACK_A2A_ROOMS`

Otherwise the reply is delivered the normal way.

The feature is off for every agent group until an operator turns it on. When it is off, the container writes no progress or stream rows and the host makes no Slack calls for it.

The host stores plan and stream state in tables in the central database.

## Prerequisites

- Slack must be installed with `/add-slack` first. This skill uses its Slack client.
- NanoClaw's chat delivery interceptor seam must be present in `src/delivery.ts`.
- NanoClaw's container progress seam must be present in `container/agent-runner/src/progress-seam.ts`.
- The Slack app needs the `chat:write` scope. Slack's reference pages for `chat.startStream`, `chat.appendStream` and `chat.stopStream` list `chat:write` as the only bot token scope for each.
- The `chat.startStream` page names no special app feature, such as agent or assistant features, as a requirement. It describes the method as part of Slack's agent sessions. If streaming fails with an app or feature error in your workspace, check in Slack's docs and the app's settings.
- When streaming into a channel, `chat.startStream` needs `recipient_user_id` and `recipient_team_id`. The host sends them. Slack always needs `thread_ts` to start a stream, so only a reply inside a thread is streamed.
- `chat.startStream` is rate limited to Tier 2. When Slack answers `ratelimited`, the host waits a few seconds and retries the call in order, so no text is lost.
- Plans are not posted in channels listed in `SLACK_A2A_ROOMS`, or for a message from another chat in a shared session.

Check the code prerequisites. Each line must succeed; if one fails, stop and install what it names:

```nc:run effect:check
test -f src/channels/slack-lib.ts || { echo "slack-progress needs Slack: run /add-slack first" >&2; exit 1; }
grep -q "registerChatDeliveryInterceptor" src/delivery.ts || { echo "slack-progress needs registerChatDeliveryInterceptor in src/delivery.ts" >&2; exit 1; }
test -f container/agent-runner/src/progress-seam.ts || { echo "slack-progress needs container/agent-runner/src/progress-seam.ts" >&2; exit 1; }
```

## Install

### Copy the files

Copy the host module, the container module and their tests from this skill's `payload/` folder to the same paths in the project:

```nc:copy
payload/container/agent-runner/src/modules/slack-progress/describe.test.ts -> container/agent-runner/src/modules/slack-progress/describe.test.ts
payload/container/agent-runner/src/modules/slack-progress/describe.ts -> container/agent-runner/src/modules/slack-progress/describe.ts
payload/container/agent-runner/src/modules/slack-progress/index.ts -> container/agent-runner/src/modules/slack-progress/index.ts
payload/container/agent-runner/src/modules/slack-progress/registration.test.ts -> container/agent-runner/src/modules/slack-progress/registration.test.ts
payload/container/agent-runner/src/modules/slack-progress/splitter.test.ts -> container/agent-runner/src/modules/slack-progress/splitter.test.ts
payload/container/agent-runner/src/modules/slack-progress/splitter.ts -> container/agent-runner/src/modules/slack-progress/splitter.ts
payload/container/agent-runner/src/modules/slack-progress/streamer.test.ts -> container/agent-runner/src/modules/slack-progress/streamer.test.ts
payload/container/agent-runner/src/modules/slack-progress/streamer.ts -> container/agent-runner/src/modules/slack-progress/streamer.ts
payload/container/agent-runner/src/modules/slack-progress/tracker.test.ts -> container/agent-runner/src/modules/slack-progress/tracker.test.ts
payload/container/agent-runner/src/modules/slack-progress/tracker.ts -> container/agent-runner/src/modules/slack-progress/tracker.ts
payload/container/agent-runner/src/modules/slack-progress/hold.ts -> container/agent-runner/src/modules/slack-progress/hold.ts
payload/container/agent-runner/src/modules/slack-progress/hold.test.ts -> container/agent-runner/src/modules/slack-progress/hold.test.ts
payload/src/modules/slack-progress/a2a-rooms.ts -> src/modules/slack-progress/a2a-rooms.ts
payload/src/modules/slack-progress/db/migrations.ts -> src/modules/slack-progress/db/migrations.ts
payload/src/modules/slack-progress/db/progress.test.ts -> src/modules/slack-progress/db/progress.test.ts
payload/src/modules/slack-progress/db/progress.ts -> src/modules/slack-progress/db/progress.ts
payload/src/modules/slack-progress/index.ts -> src/modules/slack-progress/index.ts
payload/src/modules/slack-progress/plan.test.ts -> src/modules/slack-progress/plan.test.ts
payload/src/modules/slack-progress/plan.ts -> src/modules/slack-progress/plan.ts
payload/src/modules/slack-progress/rate-limit.ts -> src/modules/slack-progress/rate-limit.ts
payload/src/modules/slack-progress/registration.test.ts -> src/modules/slack-progress/registration.test.ts
payload/src/modules/slack-progress/render.test.ts -> src/modules/slack-progress/render.test.ts
payload/src/modules/slack-progress/render.ts -> src/modules/slack-progress/render.ts
payload/src/modules/slack-progress/settings.test.ts -> src/modules/slack-progress/settings.test.ts
payload/src/modules/slack-progress/settings.ts -> src/modules/slack-progress/settings.ts
payload/src/modules/slack-progress/plan-status.test.ts -> src/modules/slack-progress/plan-status.test.ts
payload/src/modules/slack-progress/status.test.ts -> src/modules/slack-progress/status.test.ts
payload/src/modules/slack-progress/status.ts -> src/modules/slack-progress/status.ts
payload/src/modules/slack-progress/streams.test.ts -> src/modules/slack-progress/streams.test.ts
payload/src/modules/slack-progress/streams.ts -> src/modules/slack-progress/streams.ts
payload/src/modules/slack-progress/sweep.test.ts -> src/modules/slack-progress/sweep.test.ts
payload/src/modules/slack-progress/sweep.ts -> src/modules/slack-progress/sweep.ts
payload/src/modules/slack-progress/wake.test.ts -> src/modules/slack-progress/wake.test.ts
payload/src/modules/slack-progress/wake.ts -> src/modules/slack-progress/wake.ts
payload/src/modules/slack-progress/wake-status.ts -> src/modules/slack-progress/wake-status.ts
```

### Register the host module

Add this line at the end of `src/modules/index.ts`. Importing the module creates the progress tables, registers the plan and stream handling and starts the sweep:

```nc:append to:src/modules/index.ts
import './slack-progress/index.js';
```

### Register the container module

Add this line at the end of `container/agent-runner/src/modules/index.ts`. Imports run before the runner starts, so the module is registered in time:

```nc:append to:container/agent-runner/src/modules/index.ts
import './slack-progress/index.js';
```

The container source is mounted into agent containers, so no image rebuild is needed.

## Validate

Build the host:

```nc:run effect:build
pnpm run build
```

Run the module's host tests and container tests:

```nc:run effect:test
pnpm exec vitest run src/modules/slack-progress
cd container/agent-runner && bun test src/modules/slack-progress
```

The two `registration.test.ts` files import the real barrels and fail if a module is not registered.

## Turn it on

Start the host once with this skill applied, so the migration creates the progress tables: `bash setup/lib/restart.sh`. The operator script does not run migrations. Run it only after that.

Then switch progress on for one agent group:

```bash
pnpm exec tsx .claude/skills/slack-progress/scripts/slack-progress.ts enable <agent-group-id>
```

Other commands:

```bash
pnpm exec tsx .claude/skills/slack-progress/scripts/slack-progress.ts disable <agent-group-id>
pnpm exec tsx .claude/skills/slack-progress/scripts/slack-progress.ts status <agent-group-id>
```

The script writes the setting to the central database. The container checks the setting each turn, so no restart is needed.

## Troubleshooting

**Nothing shows up.** Run `status` for the group. Progress is off until `enable` is run. Check that the host was restarted after the skill was applied.

**`enable` fails with a missing table error.** The host has not run the migration yet. Start the host once with the skill applied, then run `enable` again.

**The plan appears but replies are not streamed.** Streaming has stricter rules than the plan. Check that the reply is in a thread, that one human sender woke the agent, and that the channel is not in `SLACK_A2A_ROOMS`. Then check the host log for a Slack error from `chat.startStream`, `chat.appendStream` or `chat.stopStream`. On any such error the reply is posted normally, so nothing is lost.

**Slack answers `missing_scope` or `not_allowed_token_type`.** The app needs `chat:write` as a bot token scope. Add it and reinstall the app to the workspace.

**A reply shows twice.** The stream failed after some text was sent, the reply had a bare `@name` mention, or the streamed text did not match the final reply. The partial message ends with "_Reply posted below._" and the full reply is posted as a second message. This is expected and no text is lost.

**A plan stays open.** The sweep closes plans and streams that are silent for 2 minutes after the container has gone. Wait for the next sweep, which runs every 30 seconds.
