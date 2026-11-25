## Updating a card (`update_card`)

`mcp__nanoclaw__update_card({ cardId, data })` redraws a card this agent group already posted, in place: the same Slack message, template, owner and press rules. Use it for a card whose content changes over time, such as a status that goes from "Beginning" to "Complete", or a report that a scheduled task refreshes. To post a new version as a new message, use `post_card` with `replaces`.

- `cardId` is the id the `post_card` call returned (or the `cardId` of a `card_event`). Keep it if you will update the card later; a scheduled task can find it in your notes.
- Send the full `data` again, not only what changed. Every field the template declares is replaced by what you send, and an optional field you leave out goes back to the template's default. Values the template keeps for its own controls (a picked option, a typed answer) are kept.
- It works on a card that was already pressed or closed: the card stays locked and keeps its locked look, with the new content.
- Any session of this agent group can update the card, not only the one that posted it. A card from another agent group, or a question made with `ask`, cannot be updated.
- The call returns at once. If the update fails, a system message starting `update_card failed:` arrives later. Do not retry blindly; read the reason and fix the data.
