## Interactive cards (`post_card`)

`mcp__nanoclaw__post_card({ template, data })` posts a predefined interactive card from this agent group's card templates into the current chat or thread. Use it when the shape of the message is fixed and people respond by pressing controls. To ask people to choose between options, use `ask` in Slack chats.

- A template is two files at `/workspace/agent/plugins/<plugin>/cards/`: `<template>.json` (version 2) and the OpenUI Lang source it names in `openui` (`<template>.oui`). Before you post a template for the first time, read the JSON file. Its `data` section lists every field you may send, with its type and limits; send exactly those fields. A template with an old JSON block format (no `version: 2`) is refused.
- Pass the template name and its data only. The layout and who may press each control come from the template; you cannot change them.
- The person you are answering becomes the card's owner.
- Never retype numbers that came from a tool. Pass them through in `data` exactly as the tool returned them.
- The call returns at once. Presses arrive later as `<webhook source="slack-ui" event="card_event">` messages. Do not wait for them.
- A `card_event` payload has `cardId`, `template`, `control` (the control's name in the template), `value`, `user` (`{ id, name }`), `state` and `locked`. `state` holds the card's current values by name (for example `state.pick`), so a submit event carries the final ticks and inputs. For a form submit, `value` is an object of the submitted values by name. `locked` is `true` when that press closed the card.
- If posting fails, a system message starting `post_card failed:` arrives later. Do not post the same card twice to work around a slow card.
