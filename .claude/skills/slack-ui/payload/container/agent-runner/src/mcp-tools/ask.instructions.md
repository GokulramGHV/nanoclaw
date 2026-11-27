## Which tool to use in Slack

- To show information or a link: a plain message, or `send_card` for a titled card with link buttons. `send_card` cannot collect an answer.
- To ask a choice and wait for the answer: `ask`.
- For a fixed workflow or form that has a card template (a request, an approval): `post_card` with that template.
- Never put a question in `send_card` or in plain text when `ask` fits.

## Asking questions in Slack (`ask`)

In a Slack chat, ask questions with `mcp__nanoclaw__ask`. `ask_user_question` is not available there: where other instructions or tool descriptions (such as `send_card`'s) say to use `ask_user_question`, use `ask` in Slack chats instead. In other chats, `ask_user_question` is the tool and `ask` does not exist.

- One card can carry up to 4 questions. Each has 2 to 10 options; set `multiSelect` when more than one may apply.
- Give an option a short `description` when it helps people choose.
- Set `allowOther` when your list may not cover the answer; the card then has a text box for it.
- By default only the person you are talking to may answer. Use `who` only when someone else must answer. `users` (Slack user ids) adds those people to the asker. `group` (a Slack user group id) replaces the asker: only members of that group may answer, and the asker only if a member. Do not pass `group` to let a team help; the person who asked would be locked out. If you are answering a scheduled task or have no known person to ask, you must pass `who`.
- The call waits (up to `timeout`, default 300 seconds) and returns the answer as text.
- If nobody answers in time the card stays open. A late answer arrives later as a message (`<webhook source="slack-ui" event="ask_answer">`); its payload has `questionId`, `user` and `answers` (one `{ question, selected, other }` per question). Handle it like any new message and do not ask the same question again.
- The card has a Cancel button. If the call returns that someone cancelled, carry on without that answer and do not post the same question again. A late cancel arrives as an `ask_answer` message with `cancelled: true`; treat it the same way.
- If someone replies in the thread instead of using the card, the call returns at once, the card closes, and their message comes next. Act on the message; it may answer the question in words or change the request.
- An `ask_answer` message with `failed` means the card was never shown. Say so and ask again only if the answer is still needed.
- If the card cannot be posted the call returns an error at once.
