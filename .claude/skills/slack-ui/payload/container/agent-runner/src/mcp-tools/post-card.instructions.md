## Interactive cards (`post_card`)

`mcp__nanoclaw__post_card({ template, data })` posts a predefined interactive card from this agent group's card templates (`cards/<template>.json`) into the current chat or thread. Use it when the shape of the message is fixed and people respond by pressing controls.

- Templates live at `/workspace/agent/plugins/<plugin>/cards/<template>.json`. Before you post a template for the first time, read that file. Its `data` section lists every field you may send, with its type and limits; send exactly those fields.
- Pass the template name and its data only. The layout and who may press each control come from the template; you cannot change them.
- The person you are answering becomes the card's owner.
- Never retype numbers that came from a tool. Pass them through in `data` exactly as the tool returned them.
- The call returns at once. Presses arrive later as `<webhook source="slack-ui" event="card_event">` messages. Do not wait for them.
- If posting fails, a system message starting `post_card failed:` arrives later. Do not post the same card twice to work around a slow card.
