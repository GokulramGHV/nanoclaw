---
name: slack-team-access
description: Let a team bot's own Slack app work in any channel or DM it is invited to, with only members of one Slack user group allowed to use it, and refuse in Slack Connect (externally shared) channels. Host-enforced access control, off by default for every Slack instance, fails closed. Requires /add-slack and the permissions module.
---

# Slack team access

A team bot runs on its own Slack app (its own Slack channel-adapter instance). People invite it to channels and tag it, or DM it. Without this skill, every new channel goes to the owner's channel-registration approval card. With it, for the instances you configure:

1. **Slack Connect refusal.** In an externally shared channel (`conversations.info` says `is_ext_shared`), the message is dropped before anything else, even on a channel that is already wired. Nothing reaches any agent, the drop is recorded with its reason, and the tagger gets an ephemeral note (once per person per channel per hour).
2. **User-group gate.** Only members of one Slack user group may engage. A non-member's chat message never reaches the agent, and is recorded as a drop. (Card buttons and form submits are not chat messages; see the known limit below.) If they tagged the bot or wrote in a DM they also get an ephemeral refusal note (same rate limit). This gate covers every channel and DM on that instance wired to the configured agent group, whether auto-wired or wired by hand.
3. **Auto-wire.** When a member tags the bot in an unwired channel, or DMs it, the host creates the messaging group if needed and wires it to the configured agent group using the Slack adapter's declared wiring defaults (engage on mention in channels, thread sessions as declared), then routes the message. No approval card. A channel the owner denied stays denied. A non-member never triggers a wiring.

## Security model

- **Off by default.** An instance with no config row is untouched: routing is exactly what it was, including the owner's channel-request flow. Nothing is enabled by installing the skill.
- **Host-enforced.** It is a pre-route interceptor in the host process (`registerMessageInterceptor`), so no agent, container or chat message can switch it off or around it. Slack API calls run on the host with the instance's bot token.
- **Fails closed.** On a configured instance, any of these drops the message: the shared-channel lookup fails or takes over 3 s (treated as shared), the user-group lookup fails or takes over 1.5 s (treated as not a member), no bot token, no sender id, a database error reading the config, or any other unexpected error. Lookups that failed are never cached. Auto-wire on with no user group in the row (hand-edited database) drops everything it would have wired.
- **Scope of effect.** Only the instance named in a row. On that instance the Slack Connect refusal covers every channel, including ones wired only to another agent group. The user-group gate and auto-wire cover channels with no wiring (to auto-wire) and channels wired to the configured agent group. A channel wired only to a different agent group gets the Slack Connect refusal and nothing else. No other instance and no other agent group gets any new access.
- **No memberships, ever.** The permissions module's gates only know agent-group members, so for a channel this skill auto-wired the module registers an access grant with the router (`registerAccessGrant`, a small core hook this skill needs). The grant admits one message on one wiring: it returns true only when the instance has a config row, the wiring is the exact one this module auto-wired (recorded by wiring id in `slack_team_access_wired`, and only while it exists), it belongs to the configured agent group, and the sender is in the user group right now (a failed lookup is no grant). It can only admit, never deny, a grant that throws counts as none, and no `agent_group_members` row is written, so nothing lasts: leaving the Slack user group ends access within the 60 s cache, and nothing remains after `remove`, after removing the module, or after a change of agent group. Auto-wired wirings use `sender_scope = 'known'` and `ignored_message_policy = 'drop'` (chatter nobody tagged is never read). Channels wired by hand keep the owner's own policy: this skill only narrows them (a channel re-wired by hand is not treated as auto-wired, because the record names the wiring id).
- **Changing the agent group, or removing the config.** `set` with a different `--agent-group`, and `remove`, are refused while channels auto-wired to the old group still have that wiring, because they would lose the gate. Delete those wirings, or pass `--release-auto-wired` to keep them wired by hand (the owner's policy then governs them, plus the Slack Connect refusal).
- **Cards.** Button clicks and form submits are not chat messages and do not pass through message routing. What this module does and does not cover:
  - `ask_user_question` cards have no access rule of their own: anyone who can see the card can answer it. This module adds one: a prepended response handler refuses an answer (a private "not allowed" note, the card keeps its buttons) unless the clicker is in the user group. It claims only answers that have a pending-question row in a session of the configured agent group on a configured instance, so approval cards (owner approvals) are never seen or blocked, and a failed lookup refuses.
  - slack-ui cards (buttons, forms) follow the card's own access rule. The default is the card owner (the person who asked), Feedback cards are open to anyone, and an agent can choose `anyone`. This module cannot enforce on them. In gated channels have the agent use the group rule, `{"group":"S..."}` with the same user group id, so only members can act.
- **Mixed channels.** If a channel is wired to the configured agent group and also to another one, a non-member's message is dropped for both (stricter, never wider).
- **Notes are rate limited in memory** (once per person per channel per hour; a host restart resets it). Ephemeral notes go in the thread when the message was in one. In a DM, where Slack may not allow an ephemeral, a plain note is posted into that DM.
- A note on tagged-only: the Slack Connect note and the refusal note are sent only when the person tagged the bot or wrote in a DM. Untagged chatter is dropped silently (and recorded).

## Prerequisites

- Slack installed with `/add-slack`; the instance is `slack` for the default app or `slack-<name>` for a `SLACK_INSTANCES` entry.
- The permissions module (`src/modules/permissions/`).
- The router's `registerAccessGrant` hook (core, commit "feat(router): registerAccessGrant"). Without it the module throws at start with a clear error rather than run ungated.
- Bot scopes: `usergroups:read`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `chat:write`. Without `usergroups:read` every message is refused (the group lookup fails); without the `*:read` scope for a conversation type, the shared-channel lookup fails and that type is refused. After adding scopes, reinstall the Slack app and update the bot token.

Check the code prerequisites:

```nc:run effect:check
test -f src/channels/slack-lib.ts || { echo "slack-team-access needs Slack: run /add-slack first" >&2; exit 1; }
grep -q "export function registerAccessGrant" src/router.ts || { echo "slack-team-access needs registerAccessGrant in src/router.ts (core change)" >&2; exit 1; }
test -f src/modules/permissions/index.ts || { echo "slack-team-access needs the permissions module" >&2; exit 1; }
```

## Install

### Copy the files

```nc:copy
payload/src/modules/slack-team-access/config.test.ts -> src/modules/slack-team-access/config.test.ts
payload/src/modules/slack-team-access/config.ts -> src/modules/slack-team-access/config.ts
payload/src/modules/slack-team-access/db/migrations.ts -> src/modules/slack-team-access/db/migrations.ts
payload/src/modules/slack-team-access/gate.test.ts -> src/modules/slack-team-access/gate.test.ts
payload/src/modules/slack-team-access/gate.ts -> src/modules/slack-team-access/gate.ts
payload/src/modules/slack-team-access/index.ts -> src/modules/slack-team-access/index.ts
payload/src/modules/slack-team-access/registration.test.ts -> src/modules/slack-team-access/registration.test.ts
payload/src/modules/slack-team-access/slack-api.ts -> src/modules/slack-team-access/slack-api.ts
```

### Register the host module

Add this line at the end of `src/modules/index.ts`, after the permissions import. Importing the module creates the config tables and registers the interceptor, the access grant and the card-answer handler (all do nothing until an instance has a row):

```nc:append to:src/modules/index.ts
import './slack-team-access/index.js';
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/modules/slack-team-access
```

## Configure an instance

Start the host once with this skill applied, so the migration creates the tables: `bash setup/lib/restart.sh`. The operator script does not run migrations, so run it only after that.

```bash
# Team bot: auto-wire anything it is invited to, only members of user group S0EXAMPLE1 may use it,
# refuse Slack Connect channels (the default).
pnpm exec tsx .claude/skills/slack-team-access/scripts/slack-team-access.ts \
  set slack-example --agent-group ag-example --user-group S0EXAMPLE1 --auto-wire

# Gate and external refusal only: owner keeps approving channels, but wired channels are limited to the group.
pnpm exec tsx .claude/skills/slack-team-access/scripts/slack-team-access.ts \
  set slack-example --agent-group ag-example --user-group S0EXAMPLE1

# Custom ephemeral texts; --allow-external turns the Slack Connect refusal off.
pnpm exec tsx .claude/skills/slack-team-access/scripts/slack-team-access.ts \
  set slack-example --agent-group ag-example --user-group S0EXAMPLE1 --auto-wire \
  --refusal-note "This bot is for the example team." --external-note "Not available in shared channels."

pnpm exec tsx .claude/skills/slack-team-access/scripts/slack-team-access.ts show slack-example
pnpm exec tsx .claude/skills/slack-team-access/scripts/slack-team-access.ts remove slack-example   # add --release-auto-wired if channels were auto-wired
```

- `<instance>` is `slack` or `slack-<name>`. `set` replaces the whole row: flags you leave out return to their defaults (auto-wire off, external refused, default notes).
- `--user-group` is the Slack user group id (`S...`, from the user group's About page or `usergroups.list`). `--auto-wire` is refused without it.
- The host reads the row on each message, so no restart is needed. `remove` switches the module off for that instance; channels it already wired stay wired (with the owner's usual policy from then on).

## Troubleshooting

- Everyone is refused and the log says `user group lookup failed`: add `usergroups:read` and reinstall the app; check the user group id.
- Everyone is refused in some channel and the log says `shared-channel lookup failed`: add the `*:read` scope for that conversation type (`channels:read`, `groups:read`, `im:read`, `mpim:read`) and reinstall.
- Nothing happens and no note is sent: the instance has no row (`show`), or the bot token for the instance is missing from `.env`.
- A member is refused right after being added to the user group: the membership list is cached for up to 60 s.
- Refusals show in `ncl dropped-messages list` with reasons `slack_external_channel`, `slack_external_lookup_failed`, `slack_not_in_user_group`, `slack_group_lookup_failed`, `slack_unknown_sender`, `slack_team_access_misconfigured`.
