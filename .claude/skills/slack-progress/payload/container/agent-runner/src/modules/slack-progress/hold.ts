/**
 * Mid-task message hold. While the turn's task list still has unfinished steps, a
 * message to the turn's own chat is usually narration ("Still working...", "Step 2 is
 * done"), which the plan message already shows. Such a message is held, not written.
 *
 * At turn end only the turn's last message to that chat counts:
 * - the last message was held: write it (a question, a failure, or the reply itself),
 *   and drop the held ones before it;
 * - the last message was written normally: drop every held one.
 */
import type { ChatRowInfo, ProgressEvent } from '../../progress-seam.js';

export interface HoldDeps {
  stepsOpen(platformId: string): boolean;
  log(msg: string): void;
}

export function createHold(deps: HoldDeps): {
  onEvent(e: ProgressEvent): void;
  offer(row: ChatRowInfo, write: () => Promise<void>): boolean;
} {
  /** Per chat: the held messages, and whether the latest message to that chat was held. */
  let chats = new Map<string, { held: (() => Promise<void>)[]; lastHeld: boolean }>();

  function offer(row: ChatRowInfo, write: () => Promise<void>): boolean {
    const c = chats.get(row.platformId);
    if (deps.stepsOpen(row.platformId)) {
      if (c) {
        c.held.push(write);
        c.lastHeld = true;
      } else chats.set(row.platformId, { held: [write], lastHeld: true });
      return true;
    }
    if (c) c.lastHeld = false;
    return false;
  }

  function settle(): void {
    const all = chats;
    chats = new Map();
    let dropped = 0;
    const keep: (() => Promise<void>)[] = [];
    for (const c of all.values()) {
      if (c.lastHeld) keep.push(c.held[c.held.length - 1]!);
      dropped += c.held.length - (c.lastHeld ? 1 : 0);
    }
    if (dropped > 0) deps.log(`dropped ${dropped} mid-task message(s) replaced by a later message`);
    for (const write of keep) {
      void write().catch((err) => {
        deps.log(`held message write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  function onEvent(e: ProgressEvent): void {
    if (e.type === 'turn_start') {
      // A turn that never ended cleanly: do not lose its last held message.
      if (chats.size > 0) settle();
    } else if (e.type === 'turn_end') {
      settle();
    }
  }

  return { onEvent, offer };
}
