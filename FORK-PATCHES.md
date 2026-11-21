# Fork patches

Edits this fork makes to upstream trunk files, so merge conflicts are quick to find.

| File                                       | Lines touched                                                                                           | Why                                                                                                     | Upstream candidate |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| `src/channels/question-render-registry.ts` | End of file: `ModalSubmitHandler`, `registerModalSubmitHandler`, `dispatchModalSubmit`; one import line | Seam so modules can handle form (modal) submits, parallel to `registerQuestionActionHandler` for clicks | yes                |
| `src/channels/chat-sdk-bridge.ts`          | Import of `dispatchModalSubmit`; one `chat.onModalSubmit(...)` registration next to `chat.onAction`     | The bridge never registered a modal-submit handler, so Slack form submits were dropped                  | yes                |
