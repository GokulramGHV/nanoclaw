---
name: slack-ui
description: Add interactive Slack cards and questions to NanoClaw agents. An agent posts a card from an OpenUI Lang template in its group's plugin folder (buttons, checkboxes, selects, text inputs, forms that open a modal), the template says who may press each control, a button press locks the card, and presses come back as card_event messages. The agent can also ask one to four multiple-choice questions on a card with the ask tool and wait for the answer. Use when an agent needs buttons, inputs, forms or questions in Slack with fixed layout and press rules. Requires /add-slack.
---

# Slack UI cards

This skill adds two tools for agents, `post_card` and `ask`, and the host code behind them. Cards are drawn and tracked by the `slack-ui-kit` package.

**`post_card`**

- The agent calls `post_card({ template, data })`. The host loads `cards/<template>.json` and its OpenUI Lang source from one of the agent group's plugin folders, passes `data` in as the card's starting state, and posts the card into the current Slack chat or thread.
- Cards can hold buttons, checkboxes, selects, text inputs and forms. A form shows as a button; pressing it opens a modal within Slack's 3 second limit.
- In an `agent-shared` session the card goes to the session's routed chat.
- The person the agent is answering becomes the card's owner.
- The template decides who may press each control: the owner, anyone, a list of users, or members of one Slack user group. A control with no rule is owner-only. The agent cannot change the rules.
- A button press locks the card when an allowed person presses it. The card is redrawn without its controls and shows who submitted it and when.
- Presses come back to the agent as `card_event` messages.

**`ask`**

- The agent calls `ask({ questions, who?, timeout? })`. One card carries up to 4 questions. Each question has 2 to 10 options, each with an optional short description, and can allow several choices (`multiSelect`) or a typed answer (`allowOther`).
- By default only the person the agent is answering may answer. `who` names other users, or one Slack user group.
- One Send button locks the card. It is refused with a private note until every question has an answer.
- The tool waits up to `timeout` seconds (30 to 300, default 300) and returns the answer as text. If nobody answers in time, the card stays open and a late answer arrives as a normal `ask_answer` message that wakes the agent.
- In a Slack chat `ask` replaces `ask_user_question`, which is hidden there. Other channels keep `ask_user_question` and do not see `ask`.

The host stores each card in a `ui_kit_cards` table in the central database.

## Prerequisites

- Slack must be installed with `/add-slack` first. This skill uses its Slack client.
- NanoClaw's click and form-submit handler seams must be present in `src/channels/question-render-registry.ts`.
- The agent-runner needs the message-claim and tool-hiding seams (`container/agent-runner/src/message-claims.ts`, and `hideTool` in `container/agent-runner/src/mcp-tools/server.ts`). `ask` uses both.
- The Slack app needs the `chat:write` scope. It needs `usergroups:read` only if a template or an `ask` call uses a user-group rule.

Check the code prerequisites. Each line must succeed; if one fails, stop and install what it names:

```nc:run effect:check
test -f src/channels/slack-lib.ts || { echo "slack-ui needs Slack: run /add-slack first" >&2; exit 1; }
grep -q "export function registerQuestionActionHandler" src/channels/question-render-registry.ts || { echo "slack-ui needs registerQuestionActionHandler in src/channels/question-render-registry.ts" >&2; exit 1; }
grep -q "export function registerModalSubmitHandler" src/channels/question-render-registry.ts || { echo "slack-ui needs the form-submit seam (registerModalSubmitHandler) in src/channels/question-render-registry.ts" >&2; exit 1; }
test -f container/agent-runner/src/message-claims.ts || { echo "slack-ui needs the message-claim seam: container/agent-runner/src/message-claims.ts" >&2; exit 1; }
grep -q "export function hideTool" container/agent-runner/src/mcp-tools/server.ts || { echo "slack-ui needs hideTool in container/agent-runner/src/mcp-tools/server.ts" >&2; exit 1; }
```

## Install

### Install the dependencies

The host module needs `slack-ui-kit` and `zod`. Pin `zod` to an exact version:

```nc:dep
zod@4.6.7
```

`slack-ui-kit` is not on npm. It installs from a GitHub release tag, pinned to that tag:

```nc:run effect:external
pnpm add github:GokulramGHV/slack-ui-kit#v0.1.1
```

The kit depends on `@openuidev/lang-core`, whose install script is telemetry. pnpm skips it, and it stays skipped: never add `@openuidev/lang-core` to `onlyBuiltDependencies` in `pnpm-workspace.yaml`. The module also sets `OPENUI_TELEMETRY_DISABLED=1` before the kit loads.

### Copy the files

Copy the host module, the container tools and their tests from this skill's `payload/` folder to the same paths in the project:

```nc:copy
payload/src/modules/slack-ui/ask.test.ts -> src/modules/slack-ui/ask.test.ts
payload/src/modules/slack-ui/ask.ts -> src/modules/slack-ui/ask.ts
payload/src/modules/slack-ui/clicks.test.ts -> src/modules/slack-ui/clicks.test.ts
payload/src/modules/slack-ui/clicks.ts -> src/modules/slack-ui/clicks.ts
payload/src/modules/slack-ui/db/kit-cards.test.ts -> src/modules/slack-ui/db/kit-cards.test.ts
payload/src/modules/slack-ui/db/kit-cards.ts -> src/modules/slack-ui/db/kit-cards.ts
payload/src/modules/slack-ui/db/migrations.ts -> src/modules/slack-ui/db/migrations.ts
payload/src/modules/slack-ui/event-ids.test.ts -> src/modules/slack-ui/event-ids.test.ts
payload/src/modules/slack-ui/events.test.ts -> src/modules/slack-ui/events.test.ts
payload/src/modules/slack-ui/events.ts -> src/modules/slack-ui/events.ts
payload/src/modules/slack-ui/forms.test.ts -> src/modules/slack-ui/forms.test.ts
payload/src/modules/slack-ui/forms.ts -> src/modules/slack-ui/forms.ts
payload/src/modules/slack-ui/index.ts -> src/modules/slack-ui/index.ts
payload/src/modules/slack-ui/kit.ts -> src/modules/slack-ui/kit.ts
payload/src/modules/slack-ui/notify.test.ts -> src/modules/slack-ui/notify.test.ts
payload/src/modules/slack-ui/notify.ts -> src/modules/slack-ui/notify.ts
payload/src/modules/slack-ui/post-card.test.ts -> src/modules/slack-ui/post-card.test.ts
payload/src/modules/slack-ui/post-card.ts -> src/modules/slack-ui/post-card.ts
payload/src/modules/slack-ui/registration.test.ts -> src/modules/slack-ui/registration.test.ts
payload/src/modules/slack-ui/slack-client.test.ts -> src/modules/slack-ui/slack-client.test.ts
payload/src/modules/slack-ui/slack-client.ts -> src/modules/slack-ui/slack-client.ts
payload/src/modules/slack-ui/telemetry.ts -> src/modules/slack-ui/telemetry.ts
payload/src/modules/slack-ui/template.test.ts -> src/modules/slack-ui/template.test.ts
payload/src/modules/slack-ui/template.ts -> src/modules/slack-ui/template.ts
payload/container/agent-runner/src/mcp-tools/ask-registration.test.ts -> container/agent-runner/src/mcp-tools/ask-registration.test.ts
payload/container/agent-runner/src/mcp-tools/ask.instructions.md -> container/agent-runner/src/mcp-tools/ask.instructions.md
payload/container/agent-runner/src/mcp-tools/ask.test.ts -> container/agent-runner/src/mcp-tools/ask.test.ts
payload/container/agent-runner/src/mcp-tools/ask.ts -> container/agent-runner/src/mcp-tools/ask.ts
payload/container/agent-runner/src/mcp-tools/post-card-registration.test.ts -> container/agent-runner/src/mcp-tools/post-card-registration.test.ts
payload/container/agent-runner/src/mcp-tools/post-card.instructions.md -> container/agent-runner/src/mcp-tools/post-card.instructions.md
payload/container/agent-runner/src/mcp-tools/post-card.test.ts -> container/agent-runner/src/mcp-tools/post-card.test.ts
payload/container/agent-runner/src/mcp-tools/post-card.ts -> container/agent-runner/src/mcp-tools/post-card.ts
```

### Register the host module

Add this line at the end of `src/modules/index.ts`. Importing the module creates the `ui_kit_cards` table, registers the click, form-submit and card-event handlers, and registers the `post_card` and `ask` delivery actions:

```nc:append to:src/modules/index.ts
import './slack-ui/index.js';
```

### Register the agent tools

Add these lines at the end of `container/agent-runner/src/mcp-tools/index.ts`. Imports run before the file's own code, so both tools are registered before the MCP server starts:

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './post-card.js';
import './ask.js';
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
cd container/agent-runner && bun test src/mcp-tools/post-card.test.ts src/mcp-tools/post-card-registration.test.ts src/mcp-tools/ask.test.ts src/mcp-tools/ask-registration.test.ts
```

`registration.test.ts` imports the real modules barrel and fails if the `post_card` or `ask` action is not registered. `post-card-registration.test.ts` and `ask-registration.test.ts` fail if the MCP tools barrel does not import the tool.

## Writing a card template

A template is two files in one of the agent group's plugin folders, at `groups/<folder>/plugins/<plugin>/cards/`:

- `<name>.json` describes the data, the press rules and which source to use.
- `<name>.oui` holds the card layout in OpenUI Lang. Its name is the JSON file's `openui` value: a plain file name ending in `.oui`, with no folders.

`<name>` uses lowercase letters, digits and dashes, starts with a letter or digit, and is at most 64 characters. The same name must not appear in two plugins of one group. A template file or source that is a symlink is refused.

`cards/demo-request.json`:

```json
{
  "version": 2,
  "data": {
    "title": { "type": "string", "required": true, "maxLength": 150 },
    "items": { "type": "array", "maxItems": 10, "items": {
      "name": { "type": "string", "required": true, "maxLength": 60 } } }
  },
  "access": { "byId": { "pick": "owner", "create": "owner" } },
  "openui": "demo-request.oui"
}
```

`cards/demo-request.oui`:

```
root = Root([intro, acts])
$title = ""
$items = []
$pick = []
$choice = ""
intro = Section("*" + $title + "*\nTick what you want, then press Create.")
acts = Actions([pick, create])
pick = Checkboxes("pick", $pick, @Each($items, "it", Option(it.name, it.name)))
create = Button("Create", Action([@Set($choice, "create")]), "primary")
```

Two ready-made examples, one with a user-group rule, are in this skill's `examples/cards/` folder.

### The JSON file

- `version` must be `2`.
- `data` declares every field the agent may send. Types are `string` (with `maxLength`, default 3000), `number`, `boolean` and `array` (with `maxItems`, default 50, and `items` as an object schema of the same kind). Unknown fields are rejected.
- `access` holds the press rules, see below.
- `openui` names the `.oui` file beside the JSON file.

### The OpenUI Lang file

- Each line is a statement: `name = Component(...)`. `root = Root([...])` is the card. The kit's README (`node_modules/slack-ui-kit/README.md`) lists the components: Section, Actions, Button, Checkboxes, Radio, Select, TextBox, Form, Table, Card, Plan and more.
- A `$name = <default>` statement declares a state variable. Inputs bind to variables, and a button's `Action([@Set($choice, "create")])` changes them.
- **Data arrives as the starting state.** Each `data` field becomes the variable of the same name, with `$` in front (`title` becomes `$title`). Every string value has `&`, `<` and `>` entity-escaped, so data cannot add Slack markup, and data never becomes part of the source.
- **A default cannot depend on data.** Defaults are evaluated before the data is applied, so `$pick = @Each($items, ...)` yields an empty list, not one entry per item. Declare simple defaults (`""`, `[]`, `false`) and let the person fill them in.
- A control's id is the name of the statement that defines it (`create` for `create = Button(...)`, `pick` for `pick = Checkboxes(...)`). That id is what `access.byId` and the `card_event` `control` field use.

### Who may press

`access` keys, all optional:

- `default`, `buttons`, `inputs`, `feedback`, `forms`: a rule for that kind of control. `default` covers anything with no other rule, and is `"owner"` when missing. `feedback` defaults to `"anyone"`.
- `byId`: a rule for one control, keyed by its statement name, for example `{ "ack": { "group": "S0EXAMPLE" } }`. A key that matches no statement does nothing.
- `lock`: `"buttons"` (default), `"never"` or `{ "ids": ["create"] }`.

A rule is `"owner"`, `"anyone"`, `{ "group": "<Slack user group id>" }` or `{ "users": ["U0EXAMPLE", "U0EXAMPLE2"] }`. A refused press gets a private note, no event and no lock. A refused input change also puts the control back on the clicker's screen.

A group rule looks members up with `usergroups.users.list` (cached for 60 seconds). If the lookup fails or takes more than 1.5 seconds, the press is denied.

### Locking

With the default `lock: "buttons"`, any action button locks the card for everyone when an allowed person presses it. A button that opens a form, a link button and feedback never lock. A form submit locks. Use `lock: "never"` for a card meant for repeated presses, or `lock: { "ids": [...] }` to lock only on the named controls. One press locks the whole card, including every row of a table or carousel.

### Forms

A `Form(...)` goes at the top level of `root`, not inside `Actions`. It renders as one button. Pressing it opens a modal with the form's fields; submitting sets each field's variable, runs the form's optional action, and locks the card.

```
root = Root([intro, report])
$note = ""
$level = ""
intro = Section("Something to report?")
report = Form("Report", "Send", [TextInput("Note", $note), Select("Level", $level, [Option("low", "Low"), Option("high", "High")])])
```

Only people the `forms` rule allows (default: the owner) can open and submit it. Field errors, such as an invalid email in an `EmailInput`, show in the modal and the form stays open. Nothing is saved or locked until the submit is accepted. The modal opens before anything else runs, so it opens within Slack's 3 seconds.

### Slack limits that still apply

Slack rejects a card when one of these is too long:

- option text: 75 characters
- option description: 75 characters (the kit clips it)
- option value: 150 characters
- button text: 75 characters
- header text: 150 characters
- section text: 3000 characters

Set `maxLength` on every `data` field that feeds one of these. Without it, a long value makes the post fail.

### What the agent receives

A press on a button, feedback, or a form submit sends a message like `<webhook source="slack-ui" event="card_event">` with this payload:

- `cardId`: the card's id.
- `template`: the template name.
- `control`: the control's id (its statement name).
- `value`: the pressed control's value. For a form submit it is an object of the submitted values, keyed by variable name without `$`.
- `user`: `{ id, name }` of the person who pressed.
- `state`: the card's current state after the press, with keys without `$` (`pick`, `choice`). A submit event holds the final ticks and inputs.
- `locked`: `true` when this press locked the card.

Ticking a checkbox or typing in a box does not send an event on its own; the state arrives with the next button press.

An `ask` card sends no `card_event`. Its answer is an `ask_answer` message, with this payload:

- `questionId`: the id of the question.
- `user`: `{ id, name }` of the person who answered.
- `answers`: one entry per question, in order: `{ question, selected, other }`, where `selected` is a list of option labels and `other` is the typed text (when `allowOther` was set).
- `failed`: instead of the above, a short reason when the card could not be posted.

While the agent's `ask` call waits, it receives the same answer as the tool result and no message is sent. After the call timed out, the answer arrives as the message. A `failed` message that arrives after a timeout means the card was never shown.

### Old templates

A template with `version: 1`, or no version, is the old JSON block format. `post_card` refuses it with "uses the old JSON block format; rewrite it in OpenUI Lang". To port one:

1. Set `"version": 2` and drop `text`, `blocks` and `controls`. Keep `data` as it is.
2. Write the layout in an `.oui` file and name it in `openui`. A `section` block becomes `Section(...)`, a `{{path}}` placeholder becomes a `$variable` that the data fills, a `$each` becomes `@Each(...)`, a checkboxes element becomes `Checkboxes(...)`, and a button becomes `Button(label, Action([@Set($var, value)]))`.
3. Move each control's `who` rule into `access.byId`, keyed by the control's statement name. Every action button locks the card by default and sends an event; there is no per-control `submit` or `notify` setting.

`examples/cards/` holds the two demo templates written this way.

## Troubleshooting

**Group presses are always refused.** The host looks up group members with `usergroups.users.list`. If the app lacks the `usergroups:read` scope, Slack answers `missing_scope`, the host logs `Slack user group lookup failed`, and every press on a group-restricted control is denied. Add the scope, reinstall the app to the workspace, and press again.

**A press answers "This card is no longer active."** The card is not in the `ui_kit_cards` table, or it was posted by another Slack app instance. Cards posted before the skill was installed, and cards from an older version of it, answer this way. Ask the agent to post a new card.

**A press answers "This was already submitted."** A button has locked the card. This is expected.

**A press answers "Please answer every question first."** An `ask` card needs an answer to every question before Send works.

**The card does not post.** The agent receives a system message starting `post_card failed:` with the reason. Common reasons:
- The chat is not a Slack chat. Cards can only be posted into a messaging group whose channel type is Slack.
- The template is missing. The `.json` and `.oui` files must be at `groups/<folder>/plugins/<plugin>/cards/` for the agent group that posts it.
- The template uses the old JSON block format, or is invalid, or the data does not match its `data` schema. The message lists the problems.
- The layout could not be rendered. The message gives the first line of the error.
- Slack is not configured for the chat's app instance, or the app lacks `chat:write`.
- Slack refused the card. A filled value too long for Slack is the usual cause (see the limits above).

**An `ask` call returns an error at once.** The reason names the problem: no one to answer (the chat has no known sender, so pass `who`), not a Slack chat, Slack not configured, or Slack refused the card.

**Presses do nothing at all.** Only one process may hold a Slack app's Socket Mode connection. If another host or a test script uses the same app token, Slack sends the press to that process instead. Stop the other process, or give it its own app.

**An answer to `ask` seems to be missing after a `/clear` or `/compact`.** The agent-runner hides an answer from the agent while an `ask` call waits for it. That claim expires after 330 seconds, after which the answer arrives as a normal message.
