/**
 * Card rendering: action ids, stored state, and the locked view. Pure logic —
 * everything here returns new structures and never mutates its input.
 */
import { randomBytes } from 'node:crypto';

import type { UiCard } from './db/ui-cards.js';
import { escapeMrkdwn, fillTemplate } from './template.js';

export type CardState = Record<string, string | string[]>;

type Obj = Record<string, unknown>;

const PREFIX = 'ncu:';
const MULTI_TYPES = new Set(['checkboxes', 'multi_static_select']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SECTION_TEXT = 3000;
const MAX_BLOCKS = 50;
const SINGLE_TYPES = new Set(['static_select', 'radio_buttons']);

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function parseActionId(id: string): { cardId: string; control: string } | null {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const control = rest.slice(i + 1);
  if (control === '') return null;
  return { cardId: rest.slice(0, i), control };
}

function controlOf(actionId: unknown): string | null {
  return typeof actionId === 'string' ? (parseActionId(actionId)?.control ?? actionId) : null;
}

/** Rebuild a tree, transforming every interactive element (actions elements and section accessories). */
function mapElements(blocks: unknown[], fn: (el: Obj) => Obj): unknown[] {
  return (blocks ?? []).map((b) => {
    if (!isObj(b)) return b;
    const out: Obj = { ...b };
    if (b.type === 'actions' && Array.isArray(b.elements)) {
      out.elements = b.elements.map((el) => (isObj(el) ? fn(el) : el));
    }
    if (isObj(b.accessory)) out.accessory = fn(b.accessory);
    return out;
  });
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function rewriteIds(node: unknown, cardId: string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteIds(n, cardId));
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === 'action_id' && typeof v === 'string' ? `${PREFIX}${cardId}:${v}` : rewriteIds(v, cardId);
  }
  return out;
}

export function withActionIds(blocks: unknown[], cardId: string): unknown[] {
  return rewriteIds(blocks, cardId) as unknown[];
}

function elementValue(el: Obj): string | string[] | undefined {
  const type = el.type;
  if (typeof type !== 'string') return undefined;
  if (MULTI_TYPES.has(type)) {
    const sel = Array.isArray(el.selected_options) ? el.selected_options : [];
    return sel.flatMap((o) => (isObj(o) && typeof o.value === 'string' ? [o.value] : []));
  }
  if (SINGLE_TYPES.has(type)) {
    return isObj(el.selected_option) && typeof el.selected_option.value === 'string'
      ? el.selected_option.value
      : undefined;
  }
  if (type === 'plain_text_input') return typeof el.value === 'string' ? el.value : '';
  return undefined;
}

export function stateFromPayload(raw: unknown): CardState {
  const state: CardState = {};
  const take = (id: unknown, el: unknown): void => {
    if (!isObj(el) || typeof id !== 'string') return;
    const parsed = parseActionId(id);
    if (!parsed) return;
    const v = elementValue(el);
    if (v !== undefined && !UNSAFE_KEYS.has(parsed.control)) state[parsed.control] = v;
  };
  try {
    if (!isObj(raw)) return {};
    const values = isObj(raw.state) ? raw.state.values : undefined;
    if (isObj(values)) {
      for (const block of Object.values(values)) {
        if (isObj(block)) for (const [id, el] of Object.entries(block)) take(id, el);
      }
    }
    if (Array.isArray(raw.actions)) for (const el of raw.actions) take(isObj(el) ? el.action_id : undefined, el);
  } catch {
    return {};
  }
  return state;
}

export function mergeState(stored: CardState, fromPayload: CardState): CardState {
  return { ...stored, ...fromPayload };
}

function optionsOf(el: Obj): Obj[] {
  return Array.isArray(el.options) ? el.options.filter(isObj) : [];
}

function applyToElement(el: Obj, state: Record<string, unknown>): Obj {
  const control = controlOf(el.action_id);
  const type = el.type;
  if (control === null || typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(state, control)) return el;
  const v = state[control];
  const out: Obj = { ...el };
  if (MULTI_TYPES.has(type)) {
    if (!isStringArray(v)) return el;
    const chosen = optionsOf(el).filter((o) => typeof o.value === 'string' && v.includes(o.value));
    if (chosen.length > 0) out.initial_options = chosen;
    else delete out.initial_options;
  } else if (SINGLE_TYPES.has(type)) {
    if (typeof v !== 'string') return el;
    const match = optionsOf(el).find((o) => o.value === v);
    if (match) out.initial_option = match;
    else delete out.initial_option;
  } else if (type === 'plain_text_input') {
    if (typeof v !== 'string') return el;
    out.initial_value = v;
  } else {
    return el;
  }
  return out;
}

export function applyState(blocks: unknown[], state: Record<string, unknown>): unknown[] {
  return clone(mapElements(blocks, (el) => applyToElement(el, state)));
}

/**
 * Option text for a mrkdwn line. Fill already escaped mrkdwn and markdown
 * text; plain text and the value fallback are escaped here.
 */
function optionLabel(o: Obj): string {
  const text = isObj(o.text) && typeof o.text.text === 'string' ? o.text : undefined;
  if (text && (text.type === 'mrkdwn' || text.type === 'markdown')) return text.text as string;
  return escapeMrkdwn(String((text ? text.text : o.value) ?? ''));
}

function chosenLine(el: Obj, state: Record<string, unknown>): Obj | null {
  if (typeof el.type !== 'string' || !MULTI_TYPES.has(el.type)) return null;
  const control = controlOf(el.action_id);
  const v = control !== null ? state[control] : undefined;
  const picked = isStringArray(v) ? v : [];
  const names = optionsOf(el)
    .filter((o) => typeof o.value === 'string' && picked.includes(o.value))
    .map(optionLabel);
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: capText(`*Chosen (${names.length}):* `, names.join(', ') || 'none') },
  };
}

/** `prefix + body`, cut to Slack's section limit, ending with an ellipsis when cut. */
function capText(prefix: string, body: string): string {
  const full = prefix + body;
  if (full.length <= MAX_SECTION_TEXT) return full;
  return full.slice(0, MAX_SECTION_TEXT - 1) + '\u2026';
}

export function lockedBlocks(
  blocks: unknown[],
  state: Record<string, unknown>,
  label: string,
  userId: string,
  at: Date,
): unknown[] {
  let out: unknown[] = [];
  const chosen = new Set<unknown>();
  for (const b of blocks ?? []) {
    if (!isObj(b)) {
      out.push(clone(b));
      continue;
    }
    if (b.type === 'actions') {
      for (const el of Array.isArray(b.elements) ? b.elements : []) {
        const line = isObj(el) ? chosenLine(el, state) : null;
        if (line) {
          out.push(line);
          chosen.add(line);
        }
      }
      continue;
    }
    const { accessory, ...rest } = b;
    out.push(clone(rest));
    const line = isObj(accessory) ? chosenLine(accessory, state) : null;
    if (line) {
      out.push(line);
      chosen.add(line);
    }
  }
  if (out.length + 1 > MAX_BLOCKS && chosen.size > 1) {
    const texts = out.filter((b) => chosen.has(b)).map((b) => ((b as Obj).text as Obj).text as string);
    const merged = { type: 'section', text: { type: 'mrkdwn', text: capText('', texts.join('\n')) } };
    let placed = false;
    out = out.flatMap((b) => {
      if (!chosen.has(b)) return [b];
      if (placed) return [];
      placed = true;
      return [merged];
    });
  }
  out = out.slice(0, MAX_BLOCKS - 1);
  const by = userId ? ` by <@${userId}>` : '';
  const stamp = `<!date^${Math.floor(at.getTime() / 1000)}^{time_secs}|${at.toISOString()}>`;
  out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${escapeMrkdwn(label)}${by} at ${stamp}` }] });
  return out;
}

export function renderCard(card: UiCard): { text: string; blocks: unknown[] } {
  const filled = fillTemplate(card.template, card.data);
  let blocks = withActionIds(filled.blocks, card.id);
  blocks = applyState(blocks, card.state);
  if (card.locked) {
    blocks = lockedBlocks(
      blocks,
      card.state,
      'Submitted',
      card.lockedBy ?? '',
      new Date(card.lockedAt ?? card.updatedAt),
    );
  }
  return { text: filled.text, blocks: withFreshBlockIds(blocks) };
}

/**
 * Slack keeps a person's local control state (a tick the host refused) when a
 * redraw reuses the same block ids. A new id per render makes Slack draw the
 * stored state. Click handling reads controls by action_id, never block_id.
 */
function withFreshBlockIds(blocks: unknown[]): unknown[] {
  const rev = randomBytes(4).toString('hex');
  return blocks.map((b, i) => {
    if (!isObj(b)) return b;
    const own = typeof b.block_id === 'string' && b.block_id !== '' ? b.block_id.slice(0, 200) : `b${i}`;
    return { ...b, block_id: `${own}.${i}.${rev}` };
  });
}
