/**
 * Progress seam. Two small hooks a module can register into:
 *
 * - An observer gets normalized progress events from the provider and the
 *   poll loop: turn started, to-do list replaced, tool started, text delta,
 *   turn ended.
 * - A chat row decorator may add fields to the content of a `chat` row
 *   written for a complete <message> block. It can never replace `text`.
 *
 * With nothing registered, both are no-ops and nothing changes.
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

const observers: ProgressObserver[] = [];
const decorators: ChatRowDecorator[] = [];

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
      if (fields) Object.assign(merged, fields);
    } catch (err) {
      log(`decorator failed: ${errText(err)}`);
    }
  }
  delete merged.text;
  return merged;
}

export function _resetProgressSeamForTesting(): void {
  observers.length = 0;
  decorators.length = 0;
}
