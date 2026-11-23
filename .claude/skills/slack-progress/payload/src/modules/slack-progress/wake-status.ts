/**
 * Drops the wake status (see `startWakeStatus`) as soon as the session has any other
 * outbound row to deliver: a reply, a card, a reaction. It never outlives a turn that
 * had no plan and no chat reply. A `progress` row does not count, since the turn's own
 * status takes over from the wake status. Never throws into delivery.
 */
import { registerDeliveryBatchPreview } from '../../delivery.js';
import { clearWakeStatus } from './status.js';

/** Rows that belong to the progress display itself and do not end the wake status. */
function isProgressRow(row: { kind: string; content: string }): boolean {
  if (row.kind !== 'system') return false;
  try {
    const action = (JSON.parse(row.content) as { action?: unknown }).action;
    return action === 'progress' || action === 'stream_append' || action === 'stream_abort';
  } catch {
    return false;
  }
}

export function clearWakeOnOutbound(batch: Array<{ kind: string; content: string }>, session: { id: string }): void {
  if (batch.some((row) => !isProgressRow(row))) clearWakeStatus(session.id);
}

registerDeliveryBatchPreview(clearWakeOnOutbound);
