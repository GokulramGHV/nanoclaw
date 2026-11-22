/**
 * Drops the wake status (see `startWakeStatus`) when a reply goes out, so it never
 * outlives a turn that had no plan. Imported before the reply interceptor; it never
 * handles a message itself.
 */
import { registerChatDeliveryInterceptor } from '../../delivery.js';
import { clearWakeStatus } from './status.js';

export async function clearWakeOnReply(_msg: unknown, session: { id: string }): Promise<null> {
  clearWakeStatus(session.id);
  return null;
}

registerChatDeliveryInterceptor(clearWakeOnReply);
