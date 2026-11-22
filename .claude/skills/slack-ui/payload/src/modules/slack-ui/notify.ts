/**
 * The `post_card failed: ...` notice to the agent. Same shape as the trunk
 * system notice (`notifyAgent` in approvals), plus `cardInReplyTo`: the inbound
 * message the failed card was answering. When the agent re-posts in reply to
 * this notice, the owner lookup follows it back to that person.
 */
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

export async function notifyCardFailure(
  session: Session,
  text: string,
  cardInReplyTo: string | undefined,
): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
      ...(cardInReplyTo ? { cardInReplyTo } : {}),
    }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
}
