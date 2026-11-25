/**
 * `update_card` delivery action: redraw a card this agent group posted earlier,
 * in place (Slack chat.update on the same message), with new template data.
 * The card keeps its template, owner, access rules and message. Any session of
 * the agent group may update it, so a scheduled task can refresh a card that
 * a chat session posted. The handler never throws to delivery; every failure
 * becomes an `update_card failed: ...` notice to the agent.
 */
import { CardRenderError } from 'slack-ui-kit';

import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { envValue } from '../../env.js';
import { unguarded } from '../../guard/types.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getCardById } from './db/kit-cards.js';
import { kit } from './kit.js';
import { notifyCardFailure } from './notify.js';
import { CARD_ID_RE, shortMessage } from './post-card.js';
import { slackClientForToken } from './slack-client.js';
import { escapeEntities, findTemplate, TemplateError, validateData } from './template.js';

class UpdateCardError extends Error {}

async function updateCard(content: Record<string, unknown>, session: Session): Promise<void> {
  const { cardId } = content;
  if (typeof cardId !== 'string' || !CARD_ID_RE.test(cardId)) throw new UpdateCardError('invalid cardId');

  const card = await getCardById(cardId);
  // One message for every kind of miss, so a card of another group is not confirmed to exist.
  if (!card || card.meta?.kind !== 'card' || card.meta.agentGroupId !== session.agent_group_id) {
    throw new UpdateCardError('no card with that id from this agent group');
  }
  const templateName = card.meta.template;
  if (typeof templateName !== 'string' || templateName === '') throw new UpdateCardError('card has no template');

  const instance = card.meta.instance;
  const token = typeof instance === 'string' && instance !== '' ? envValue(botTokenKeyForInstance(instance)) : '';
  if (!token) throw new UpdateCardError("Slack is not configured for this card's workspace");

  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new UpdateCardError('agent group not found');

  let template: Awaited<ReturnType<typeof findTemplate>>['template'];
  let data: Record<string, unknown>;
  try {
    template = (await findTemplate(resolveGroupFolderPath(group.folder), templateName)).template;
    data = validateData(template, content.data ?? {});
  } catch (err) {
    if (err instanceof TemplateError) throw new UpdateCardError(err.message);
    throw err;
  }
  if (template.source === undefined) throw new UpdateCardError('template has no OpenUI source');

  // The kit merges on each attempt, from the card as it is then: the declared data fields are
  // replaced by what was sent (a missing optional one falls back to the source's default), and every
  // other key is state the template source owns and is kept. A later click or lock is never undone.
  const replace = {
    data: escapeEntities(data),
    replaceKeys: Object.keys(template.data),
    source: template.source,
    access: template.access,
  };

  try {
    await kit.render(template.source, Object.fromEntries(Object.entries(replace.data).map(([k, v]) => ['$' + k, v])));
  } catch (err) {
    throw new UpdateCardError(`template ${templateName} could not be rendered: ${shortMessage(err)}`);
  }
  const done = await kit.updateCard(slackClientForToken(token), card.channel, card.ts, replace);
  if (!done) throw new UpdateCardError('the card is busy or is gone, try again');
}

export async function handleUpdateCard(content: Record<string, unknown>, session: Session): Promise<void> {
  try {
    await updateCard(content, session);
  } catch (err) {
    const reason =
      err instanceof UpdateCardError ||
      err instanceof CardRenderError ||
      (err instanceof Error && err.name === 'SlackApiError')
        ? err.message
        : 'unexpected error (see host log)';
    log.warn('slack-ui: update_card failed', { err: err instanceof Error ? err.message : String(err) });
    try {
      const answered =
        typeof content.inReplyTo === 'string' && content.inReplyTo !== '' ? content.inReplyTo : undefined;
      await notifyCardFailure(session, `update_card failed: ${reason}`, answered);
    } catch (notifyErr) {
      log.error('slack-ui: could not notify agent', { err: String(notifyErr) });
    }
  }
}

registerDeliveryAction(
  'update_card',
  handleUpdateCard,
  unguarded(
    'edits only cards its own agent group posted; layout and click rules come from the template, never from the agent',
  ),
);
