/**
 * Mid-task message hold. While the turn's task list still has unfinished steps, a
 * message to the turn's own chat is usually narration ("Still working...", "Step 2 is
 * done"), which the plan message already shows. Such a message is held, not written.
 *
 * Narration and results are told apart by whether work followed:
 * - a non-quiet tool call makes every message held so far droppable narration;
 * - a message held after the last tool call is a result and is always written, in
 *   order, even when a later message passes unheld (it is written first);
 * - at turn end the results are written and the narration dropped. A turn whose only
 *   held text is narration, with nothing written after it, still writes its last held
 *   message, so a reply is never lost.
 *
 * Before a blocking question, a card or any write that bypasses the chat row path,
 * `barrier` writes what is held for that chat so the card has its context and the
 * order is kept. Held messages live in memory: a container killed hard (OOM, SIGKILL)
 * loses the ones not yet written.
 *
 * Held messages are keyed by chat and thread, so a message in one thread never drops
 * narration in another.
 */
import type { ChatRowInfo, ProgressEvent } from '../../progress-seam.js';
import { QUIET_TOOLS } from './tracker.js';

export interface HoldDeps {
  stepsOpen(platformId: string): boolean;
  log(msg: string): void;
  /** A row was held because steps are open (not because it waits behind a result). */
  onHeld?(row: ChatRowInfo): void;
}

type Write = () => Promise<void>;
interface Item {
  write: Write;
  droppable: boolean;
}
interface Chat {
  platformId: string;
  items: Item[];
  /** The latest message to this chat was held. */
  lastHeld: boolean;
}

export function createHold(deps: HoldDeps): {
  onEvent(e: ProgressEvent): void;
  offer(row: ChatRowInfo, write: Write): boolean;
  barrier(platformId: string): Promise<void>;
  /** Results (or queued writes) for this chat are not written yet, so a later message must not stream. */
  hasPending(platformId: string): boolean;
} {
  let chats = new Map<string, Chat>();
  /** Writes run one after another, so order holds and a later offer can queue behind them. */
  let tail: Promise<void> = Promise.resolve();
  let inflight = 0;

  async function exec(writes: Write[], sequential: boolean): Promise<void> {
    if (!sequential) {
      // Nothing in flight: start every write now, so each row is in outbound.db before
      // this call returns (the inserts are synchronous and keep call order). The result
      // door checks outbound.db right after turn_end and must find a held reply there.
      const started = writes.map((write) => {
        try {
          return write();
        } catch (err) {
          return Promise.reject(err);
        }
      });
      for (const p of started) {
        try {
          await p;
        } catch (err) {
          deps.log(`held message write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    for (const write of writes) {
      try {
        await write();
      } catch (err) {
        deps.log(`held message write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  function run(writes: Write[]): Promise<void> {
    const idle = inflight === 0;
    inflight++;
    // When writes are queued behind others they run one after another, so order holds.
    const next = idle ? exec(writes, false) : tail.then(() => exec(writes, true));
    tail = next.finally(() => {
      inflight--;
    });
    return tail;
  }

  /** What to write for a chat, and how many items are dropped. */
  function pick(c: Chat): { writes: Write[]; dropped: number } {
    const results = c.items.filter((i) => !i.droppable);
    const keep = results.length > 0 ? results : c.lastHeld && c.items.length > 0 ? [c.items[c.items.length - 1]!] : [];
    return { writes: keep.map((i) => i.write), dropped: c.items.length - keep.length };
  }

  function noteDropped(n: number): void {
    if (n > 0) deps.log(`dropped ${n} mid-task message(s) replaced by later work or a later message`);
  }

  function offer(row: ChatRowInfo, write: Write): boolean {
    const key = `${row.platformId}\u0000${row.threadId ?? ''}`;
    const c = chats.get(key);
    if (deps.stepsOpen(row.platformId)) {
      const item: Item = { write, droppable: false };
      if (c) {
        c.items.push(item);
        c.lastHeld = true;
      } else chats.set(key, { platformId: row.platformId, items: [item], lastHeld: true });
      deps.onHeld?.(row);
      return true;
    }
    if (c) {
      c.lastHeld = false;
      const results = c.items.filter((i) => !i.droppable);
      noteDropped(c.items.length - results.length);
      chats.delete(key);
      if (results.length > 0) {
        // The results come first, then this message, so the order is kept.
        void run([...results.map((i) => i.write), write]);
        return true;
      }
    }
    if (inflight > 0) {
      void run([write]);
      return true;
    }
    return false;
  }

  function settle(): void {
    const all = chats;
    chats = new Map();
    const writes: Write[] = [];
    let dropped = 0;
    for (const c of all.values()) {
      const p = pick(c);
      writes.push(...p.writes);
      dropped += p.dropped;
    }
    noteDropped(dropped);
    if (writes.length > 0) void run(writes);
  }

  async function barrier(platformId: string): Promise<void> {
    const writes: Write[] = [];
    let dropped = 0;
    for (const [key, c] of chats) {
      if (c.platformId !== platformId) continue;
      // The tool call that triggered this barrier already made held text droppable,
      // so the latest held message is written as the context for what follows.
      const results = c.items.filter((i) => !i.droppable);
      const keep = results.length > 0 ? results : c.items.slice(-1);
      writes.push(...keep.map((i) => i.write));
      dropped += c.items.length - keep.length;
      chats.delete(key);
    }
    noteDropped(dropped);
    if (writes.length > 0) await run(writes);
    else await tail;
  }

  function onEvent(e: ProgressEvent): void {
    if (e.type === 'turn_start') {
      // A turn that never ended cleanly: do not lose its results.
      if (chats.size > 0) settle();
    } else if (e.type === 'tool') {
      if (QUIET_TOOLS.has(e.name)) return;
      for (const c of chats.values()) for (const i of c.items) i.droppable = true;
    } else if (e.type === 'turn_end') {
      settle();
    }
  }

  function hasPending(platformId: string): boolean {
    if (inflight > 0) return true;
    for (const c of chats.values()) {
      if (c.platformId === platformId && c.items.some((i) => !i.droppable)) return true;
    }
    return false;
  }

  return { onEvent, offer, barrier, hasPending };
}

/** Tools that write their own row to a chat, so held text for that chat must go out before them. */
const CHAT_TOOLS = new Set(['post_card', 'ask_user_question', 'send_card', 'send_message']);

/**
 * Observer for tools that write a row to a chat themselves. Tool events fire in the
 * poll-loop process before the tool runs, so held text for the chat is written first and
 * the card, question or message has its context. A tool's MCP name may carry a prefix
 * (`mcp__server__post_card`); the bare name is matched. `chatOf` says which chat the tool
 * writes to (null: none, or not this turn's chat). Lives here, not in the tools, because
 * the tools run in another process and the card skill must not depend on this module.
 */
export function flushHoldOnChatTool(
  hold: { barrier(platformId: string): Promise<void> },
  chatOf: (tool: string, input: Record<string, unknown>) => string | null,
): (e: ProgressEvent) => void {
  return (e) => {
    if (e.type !== 'tool') return;
    const tool = e.name.replace(/^.*__/, '');
    if (!CHAT_TOOLS.has(tool)) return;
    const platformId = chatOf(tool, e.input ?? {});
    if (platformId) void hold.barrier(platformId);
  };
}
