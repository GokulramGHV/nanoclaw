## Asking questions in Slack (`ask`)

In a Slack chat, ask questions with `mcp__nanoclaw__ask`. `ask_user_question` is not available there.

- One card can carry up to 4 questions. Each has 2 to 10 options; set `multiSelect` when more than one may apply.
- Give an option a short `description` when it helps people choose.
- Set `allowOther` when your list may not cover the answer; the card then has a text box for it.
- By default only the person you are talking to may answer. Use `who` (`users`: Slack user ids, or `group`: a Slack user group id) only when someone else must answer.
- The call waits (up to `timeout`, default 300 seconds) and returns the answer as text.
- If nobody answers in time the card stays open. A late answer arrives later as a message (`<webhook source="slack-ui" event="ask_answer">`); handle it like any new message and do not ask the same question again.
- If the card cannot be posted the call returns an error at once.
