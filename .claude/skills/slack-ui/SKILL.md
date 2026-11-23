---
name: slack-ui
description: Add interactive Slack cards to NanoClaw agents. An agent posts a card from a JSON template in its group's plugin folder; the template says who may press each control, a submit control locks the card, and presses come back to the agent as card_event messages. Use when an agent needs buttons, checkboxes or selects in Slack with fixed layout and press rules. Requires /add-slack.
---

# Slack UI cards

This skill adds a `post_card` tool for agents and the host code behind it.

- The agent calls `post_card({ template, data })`. The host loads `cards/<template>.json` from one of the agent group's plugin folders, fills it with `data`, and posts it into the current Slack chat or thread.
- In an `agent-shared` session the card goes to the session's routed chat, the same as other cards.
- The person the agent is answering becomes the card's owner.
- The template decides who may press each control: the owner, anyone, or members of one Slack user group. A control with no rule is owner-only. The agent cannot change the rules.
- A control marked `submit` locks the card when an allowed person presses it. The card is redrawn without its controls and shows who submitted it and when.
- Presses come back to the agent as `card_event` messages with the control, its value, the presser and the card's current state.

The host stores each card in a `ui_cards` table in the central database.

## Prerequisites

- Slack must be installed with `/add-slack` first. This skill uses its Slack client.
- NanoClaw's form-submit handler seam must be present in `src/channels/question-render-registry.ts`.
- The Slack app needs the `chat:write` scope. It needs `usergroups:read` only if a template uses a user-group rule.

Check both code prerequisites. Each line must succeed; if one fails, stop and install what it names:

```nc:run effect:check
test -f src/channels/slack-lib.ts || { echo "slack-ui needs Slack: run /add-slack first" >&2; exit 1; }
grep -q "export function registerQuestionActionHandler" src/channels/question-render-registry.ts || { echo "slack-ui needs registerQuestionActionHandler in src/channels/question-render-registry.ts" >&2; exit 1; }
grep -q "export function registerModalSubmitHandler" src/channels/question-render-registry.ts || { echo "slack-ui needs the form-submit seam (registerModalSubmitHandler) in src/channels/question-render-registry.ts" >&2; exit 1; }
```

## Install

### Copy the files

Copy the host module, the container tool and their tests from this skill's `payload/` folder to the same paths in the project:

```nc:copy
payload/src/modules/slack-ui/index.ts -> src/modules/slack-ui/index.ts
payload/src/modules/slack-ui/template.ts -> src/modules/slack-ui/template.ts
payload/src/modules/slack-ui/template.test.ts -> src/modules/slack-ui/template.test.ts
payload/src/modules/slack-ui/telemetry.ts -> src/modules/slack-ui/telemetry.ts
payload/src/modules/slack-ui/kit.ts -> src/modules/slack-ui/kit.ts
payload/src/modules/slack-ui/events.ts -> src/modules/slack-ui/events.ts
payload/src/modules/slack-ui/events.test.ts -> src/modules/slack-ui/events.test.ts
payload/src/modules/slack-ui/slack-client.ts -> src/modules/slack-ui/slack-client.ts
payload/src/modules/slack-ui/slack-client.test.ts -> src/modules/slack-ui/slack-client.test.ts
payload/src/modules/slack-ui/forms.ts -> src/modules/slack-ui/forms.ts
payload/src/modules/slack-ui/forms.test.ts -> src/modules/slack-ui/forms.test.ts
payload/src/modules/slack-ui/clicks.ts -> src/modules/slack-ui/clicks.ts
payload/src/modules/slack-ui/clicks.test.ts -> src/modules/slack-ui/clicks.test.ts
payload/src/modules/slack-ui/post-card.ts -> src/modules/slack-ui/post-card.ts
payload/src/modules/slack-ui/post-card.test.ts -> src/modules/slack-ui/post-card.test.ts
payload/src/modules/slack-ui/notify.ts -> src/modules/slack-ui/notify.ts
payload/src/modules/slack-ui/notify.test.ts -> src/modules/slack-ui/notify.test.ts
payload/src/modules/slack-ui/registration.test.ts -> src/modules/slack-ui/registration.test.ts
payload/src/modules/slack-ui/db/migrations.ts -> src/modules/slack-ui/db/migrations.ts
payload/src/modules/slack-ui/db/kit-cards.ts -> src/modules/slack-ui/db/kit-cards.ts
payload/src/modules/slack-ui/db/kit-cards.test.ts -> src/modules/slack-ui/db/kit-cards.test.ts
payload/container/agent-runner/src/mcp-tools/post-card.ts -> container/agent-runner/src/mcp-tools/post-card.ts
payload/container/agent-runner/src/mcp-tools/post-card.test.ts -> container/agent-runner/src/mcp-tools/post-card.test.ts
payload/container/agent-runner/src/mcp-tools/post-card.instructions.md -> container/agent-runner/src/mcp-tools/post-card.instructions.md
payload/container/agent-runner/src/mcp-tools/post-card-registration.test.ts -> container/agent-runner/src/mcp-tools/post-card-registration.test.ts
```

### Register the host module

Add this line at the end of `src/modules/index.ts`. Importing the module creates the `ui_cards` table, registers the click handler and registers the `post_card` delivery action:

```nc:append to:src/modules/index.ts
import './slack-ui/index.js';
```

### Register the agent tool

Add this line at the end of `container/agent-runner/src/mcp-tools/index.ts`. Imports run before the file's own code, so the tool is registered before the MCP server starts:

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './post-card.js';
```

The container tool source is mounted into agent containers, so no image rebuild is needed. Restart the host so it loads the module: `bash setup/lib/restart.sh`.

## Validate

Build the host:

```nc:run effect:build
pnpm run build
```

Run the host tests and the container tests:

```nc:run effect:test
pnpm exec vitest run src/modules/slack-ui
cd container/agent-runner && bun test src/mcp-tools/post-card.test.ts src/mcp-tools/post-card-registration.test.ts
```

`registration.test.ts` imports the real modules barrel and fails if the `post_card` action is not registered. `post-card-registration.test.ts` fails if the MCP tools barrel does not import the tool.

## Writing a card template

A template is a JSON file at `groups/<folder>/plugins/<plugin>/cards/<name>.json`, inside one of the agent group's plugin folders. `<name>` uses lowercase letters, digits and dashes, starts with a letter or digit, and is at most 64 characters. The same name must not appear in two plugins of one group.

```json
{
  "version": 1,
  "text": "{{title}}",
  "data": {
    "title": { "type": "string", "required": true, "maxLength": 150 },
    "items": { "type": "array", "maxItems": 10, "items": {
      "name": { "type": "string", "required": true, "maxLength": 60 }, "count": { "type": "number" } } }
  },
  "controls": {
    "pick":   { "who": "owner" },
    "create": { "who": "owner", "submit": true },
    "ack":    { "who": { "group": "S0EXAMPLE" }, "submit": true },
    "info":   { "who": "anyone", "notify": false }
  },
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*{{title}}*" } },
    { "type": "actions", "elements": [
      { "type": "checkboxes", "action_id": "pick", "options": [
        { "$each": "items", "as": "it", "do": { "text": { "type": "plain_text", "text": "{{it.name}} ({{it.count}})" }, "value": "{{it.name}}", "$selected": "it.selected" } } ] },
      { "type": "button", "action_id": "create", "text": { "type": "plain_text", "text": "Create" }, "style": "primary" }
    ] }
  ]
}
```

- `text` is the plain fallback text for notifications. `blocks` is Slack Block Kit.
- `data` declares every field the agent may send. Types are `string` (with `maxLength`, default 3000), `number`, `boolean` and `array` (with `maxItems`, and `items` as an object schema of the same kind). Unknown fields are rejected.
- `{{path}}` inside any string is replaced by the data value at that dotted path, escaped for Slack. A missing optional value becomes an empty string.
- `{"$each": "<array path>", "as": "<name>", "do": <node>}` inside an array repeats `do` once per element. It can be nested.
- `"$selected": "<data path>"` on an option ticks it at the start when that value is `true`.
- Each `action_id` names a control. The host rewrites it to `ncu:<cardId>:<control>`.
- An `action_id` must be a fixed string. A `{{...}}` placeholder in it is rejected, so data can never pick a control or its rule. Per-item buttons made with `$each` are not supported yet.
- `controls` holds the rules. `who` is `"owner"`, `"anyone"` or `{ "group": "<Slack user group id>" }`. An element whose control has no entry is owner-only.
- `submit: true` locks the card when an allowed person presses the control.
- `notify` says whether a press sends the agent a `card_event`. It defaults to `true` for buttons and submit controls and to `false` for checkboxes and selects. Every `card_event` carries the card's current state, so a submit event holds the final ticks and choices.

The agent sees presses as messages like `<webhook source="slack-ui" event="card_event">` whose payload holds `cardId`, `template`, `control`, `value`, `user`, `state` and `locked`.

### Limits

Slack rejects a card when one of these is too long:

- option text: 75 characters
- option value: 150 characters
- button text: 75 characters
- header text: 150 characters

Set `maxLength` on every data field that feeds one of these. Without it, a long value makes the post fail with `invalid_blocks`.

## Troubleshooting

**Group presses are always refused.** The host looks up group members with `usergroups.users.list`. If the app lacks the `usergroups:read` scope, Slack answers `missing_scope`, the host logs `Slack user group lookup failed`, and every press on a group-restricted control is denied. Add the scope, reinstall the app to the workspace, and press again.

**A press answers "This card is no longer active."** The card is not in the `ui_cards` table, or it was posted by another Slack app instance. This happens for cards posted before the skill was installed or from another database. Ask the agent to post a new card.

**A press answers "This was already submitted."** A submit control has locked the card. This is expected.

**The card does not post.** The agent receives a system message starting `post_card failed:` with the reason. Common reasons:
- The chat is not a Slack chat. Cards can only be posted into a messaging group whose channel type is Slack.
- The template is missing. The file must be at `groups/<folder>/plugins/<plugin>/cards/<name>.json` for the agent group that posts it.
- The template is invalid, or the data does not match its `data` schema. The message lists the problems.
- Slack is not configured for the chat's app instance, or the app lacks `chat:write`.
- The reason ends in `invalid_blocks`. A filled value is too long for Slack, or the template is not valid Block Kit. Check the limits under Limits and set `maxLength` on the data fields.

**Presses do nothing at all.** Only one process may hold a Slack app's Socket Mode connection. If another host or a test script uses the same app token, Slack sends the press to that process instead. Stop the other process, or give it its own app.
