/**
 * Progress seam. Two small hooks a module can register into:
 *
 * - An observer gets normalized progress events from the provider and the
 *   poll loop: turn started, to-do list replaced, tool started, text delta,
 *   turn ended.
 * - A chat row decorator may add fields to the content of a `chat` row
 *   written for a complete <message> block. It can never replace `text`.
 * - A chat row hold may take a row before it is written and write it later,
 *   or drop it.
 * - A hold barrier runs before a write that bypasses the chat row path (a
 *   blocking question, a card, a direct send, an error notice), so anything a
 *   hold kept back for that chat is written first and the order is kept.
 *
 * With nothing registered, all are no-ops and nothing changes.
 *
 * A retry can end with a second turn_end and no new turn_start; observers ignore a turn_end with no open turn.
 */
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';

export interface ProgressTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type ProgressEvent =
  | { type: 'turn_start'; routing: RoutingContext; messages: MessageInRow[] }
  | { type: 'todos'; todos: ProgressTodo[] }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'text_delta'; text: string }
  | { type: 'turn_end'; outcome: 'done' | 'error' };

export interface ChatRowInfo {
  platformId: string;
  channelType: string;
  threadId: string | null;
  body: string;
}

type ProgressObserver = (e: ProgressEvent) => void;
type ChatRowDecorator = (row: ChatRowInfo) => Record<string, unknown> | null;
/** Return true to take the row: the hold then owns `write` and may call it later, or never. */
type ChatRowHold = (row: ChatRowInfo, write: () => Promise<void>) => boolean;
/** Write whatever the hold keeps back for this chat. Resolves once those writes settle. */
type HoldBarrier = (platformId: string) => Promise<void>;

const observers: ProgressObserver[] = [];
const decorators: ChatRowDecorator[] = [];
const decoratorKeys = new Set<string>();
const holds: ChatRowHold[] = [];
const barriers: HoldBarrier[] = [];

function log(msg: string): void {
  console.error(`[progress-seam] ${msg}`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerProgressObserver(fn: ProgressObserver): void {
  observers.push(fn);
}

/** Send an event to every observer. Never throws; observer errors are logged. */
export function emitProgress(e: ProgressEvent): void {
  for (const fn of observers) {
    try {
      fn(e);
    } catch (err) {
      log(`observer failed on ${e.type}: ${errText(err)}`);
    }
  }
}

export function registerChatRowDecorator(fn: ChatRowDecorator): void {
  decorators.push(fn);
}

/** Merged fields from every decorator. Never contains `text`. Never throws. */
export function decorateChatRow(row: ChatRowInfo): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const fn of decorators) {
    try {
      const fields = fn(row);
      if (fields) {
        Object.assign(merged, fields);
        for (const key of Object.keys(fields)) if (key !== 'text') decoratorKeys.add(key);
      }
    } catch (err) {
      log(`decorator failed: ${errText(err)}`);
    }
  }
  delete merged.text;
  return merged;
}

export function registerChatRowHold(fn: ChatRowHold): void {
  holds.push(fn);
}

/**
 * Offer a chat row to every hold before it is written. True means a hold took it
 * and the caller must not write it. Never throws; a failing hold counts as false.
 */
export function holdChatRow(row: ChatRowInfo, write: () => Promise<void>): boolean {
  for (const fn of holds) {
    try {
      if (fn(row, write)) return true;
    } catch (err) {
      log(`hold failed: ${errText(err)}`);
    }
  }
  return false;
}

export function registerHoldBarrier(fn: HoldBarrier): void {
  barriers.push(fn);
}

/** Call before writing to `platformId` without `holdChatRow`. Never throws; a no-op with nothing registered. */
export async function holdBarrier(platformId: string): Promise<void> {
  for (const fn of barriers) {
    try {
      await fn(platformId);
    } catch (err) {
      log(`hold barrier failed: ${errText(err)}`);
    }
  }
}

/**
 * Keys any decorator has ever added to a row (never `text`). Empty until a
 * decorator returns fields, so callers can leave their behavior unchanged
 * when nothing is registered.
 */
export function chatRowDecoratorKeys(): ReadonlySet<string> {
  return decoratorKeys;
}

export function _resetProgressSeamForTesting(): void {
  observers.length = 0;
  decorators.length = 0;
  decoratorKeys.clear();
  holds.length = 0;
  barriers.length = 0;
}
