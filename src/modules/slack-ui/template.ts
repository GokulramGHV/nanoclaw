/**
 * Card templates: load `cards/<name>.json` from an agent group's plugins,
 * validate agent-supplied data against the template's schema, and fill the
 * template into Slack Block Kit. Pure logic — the only I/O is `findTemplate`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array';
  required?: boolean;
  /** string only; default 3000. */
  maxLength?: number;
  /** array only. */
  maxItems?: number;
  /** array only: the object schema of each element. */
  items?: Record<string, FieldSpec>;
}

export type ControlRule = {
  who: 'owner' | 'anyone' | { group: string };
  submit?: boolean;
  notify?: boolean;
};

export interface CardTemplate {
  version: 1;
  /** Template name (set by parseTemplate); used as the fallback text when the filled text is empty. */
  name?: string;
  text: string;
  data: Record<string, FieldSpec>;
  controls: Record<string, ControlRule>;
  blocks: unknown[];
}

export class TemplateError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.name = 'TemplateError';
    this.problems = problems;
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_MAX_LENGTH = 3000;
const MAX_BLOCKS = 50;
const MAX_TEXT = 3000;
const MAX_CHECKBOX_OPTIONS = 10;
const MAX_ACTIONS_ELEMENTS = 25;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Same rules as `escapeSlackMrkdwn` in src/channels/slack.ts. */
export function escapeMrkdwn(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(here|channel|everyone)\b/gi, '@⁠$1');
}

// ── parse ───────────────────────────────────────────────────────────────────

function checkFieldSpecs(specs: unknown, where: string, problems: string[]): void {
  if (!isObj(specs)) {
    problems.push(`${where} must be an object`);
    return;
  }
  for (const [key, raw] of Object.entries(specs)) {
    const at = `${where}.${key}`;
    if (!isObj(raw)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    const type = raw.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'array') {
      problems.push(`${at}.type must be string, number, boolean or array`);
      continue;
    }
    if (raw.required !== undefined && typeof raw.required !== 'boolean')
      problems.push(`${at}.required must be a boolean`);
    for (const k of ['maxLength', 'maxItems'] as const) {
      if (raw[k] !== undefined && !(Number.isInteger(raw[k]) && (raw[k] as number) > 0)) {
        problems.push(`${at}.${k} must be a positive integer`);
      }
    }
    if (raw.maxLength !== undefined && type !== 'string') problems.push(`${at}.maxLength only applies to strings`);
    if (raw.maxItems !== undefined && type !== 'array') problems.push(`${at}.maxItems only applies to arrays`);
    if (raw.items !== undefined) {
      if (type !== 'array') problems.push(`${at}.items only applies to arrays`);
      else checkFieldSpecs(raw.items, `${at}.items`, problems);
    }
  }
}

function checkControls(controls: unknown, problems: string[]): void {
  if (!isObj(controls)) {
    problems.push('controls must be an object');
    return;
  }
  for (const [key, raw] of Object.entries(controls)) {
    const at = `controls.${key}`;
    if (!isObj(raw)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    const who = raw.who;
    const okWho =
      who === 'owner' || who === 'anyone' || (isObj(who) && typeof who.group === 'string' && who.group.length > 0);
    if (!okWho) problems.push(`${at}.who must be "owner", "anyone" or {"group": "<id>"}`);
    for (const k of ['submit', 'notify'] as const) {
      if (raw[k] !== undefined && typeof raw[k] !== 'boolean') problems.push(`${at}.${k} must be a boolean`);
    }
  }
}

/** Every `$each` node must sit in an array and carry `$each` (string), `as` (string) and `do`. */
function checkEach(node: unknown, where: string, inArray: boolean, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((m, i) => checkEach(m, `${where}[${i}]`, true, problems));
    return;
  }
  if (!isObj(node)) return;
  if (hasOwn(node, '$each')) {
    if (!inArray) problems.push(`${where}: $each is only allowed as an array member`);
    if (typeof node.$each !== 'string' || typeof node.as !== 'string' || !hasOwn(node, 'do')) {
      problems.push(`${where}: $each needs string "$each", string "as" and a "do" node`);
      return;
    }
    checkEach(node.do, `${where}.do`, false, problems);
    return;
  }
  for (const [k, v] of Object.entries(node)) checkEach(v, `${where}.${k}`, false, problems);
}

export function parseTemplate(json: string, name: string): CardTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new TemplateError([`template "${name}" is not valid JSON: ${(err as Error).message}`]);
  }
  if (!isObj(raw)) throw new TemplateError([`template "${name}" must be a JSON object`]);

  const problems: string[] = [];
  if (raw.version !== 1) problems.push('version must be 1');
  if (typeof raw.text !== 'string') problems.push('text must be a string');
  checkFieldSpecs(raw.data ?? {}, 'data', problems);
  checkControls(raw.controls ?? {}, problems);
  if (!Array.isArray(raw.blocks)) problems.push('blocks must be an array');
  else checkEach(raw.blocks, 'blocks', true, problems);
  if (problems.length > 0) throw new TemplateError(problems.map((p) => `template "${name}": ${p}`));

  return {
    version: 1,
    name,
    text: raw.text as string,
    data: (raw.data ?? {}) as Record<string, FieldSpec>,
    controls: (raw.controls ?? {}) as Record<string, ControlRule>,
    blocks: raw.blocks as unknown[],
  };
}

export async function findTemplate(groupDir: string, name: string): Promise<{ template: CardTemplate; path: string }> {
  if (!NAME_RE.test(name)) throw new TemplateError([`invalid template name "${name}"`]);

  const pluginsDir = path.join(groupDir, 'plugins');
  let plugins: string[] = [];
  try {
    plugins = (await fs.readdir(pluginsDir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const found: Array<{ path: string; json: string }> = [];
  for (const plugin of plugins) {
    const file = path.join(pluginsDir, plugin, 'cards', `${name}.json`);
    try {
      found.push({ path: file, json: await fs.readFile(file, 'utf8') });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
  }

  if (found.length === 0) throw new TemplateError([`no card template "${name}" in any plugin`]);
  if (found.length > 1) {
    throw new TemplateError([`card template "${name}" is ambiguous: ${found.map((f) => f.path).join(', ')}`]);
  }
  return { template: parseTemplate(found[0].json, name), path: found[0].path };
}

// ── validate ────────────────────────────────────────────────────────────────

function validateObject(specs: Record<string, FieldSpec>, value: unknown, where: string, problems: string[]): Obj {
  const out: Obj = {};
  if (!isObj(value)) {
    problems.push(`${where || 'data'} must be an object`);
    return out;
  }
  const at = (k: string) => (where ? `${where}.${k}` : k);
  for (const key of Object.keys(value)) {
    if (!hasOwn(specs, key)) problems.push(`unknown field "${at(key)}"`);
  }
  for (const [key, spec] of Object.entries(specs)) {
    const v = hasOwn(value, key) ? value[key] : undefined;
    if (v === undefined || v === null) {
      if (spec.required) problems.push(`missing required field "${at(key)}"`);
      continue;
    }
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') problems.push(`field "${at(key)}" must be a string`);
        else if (v.length > (spec.maxLength ?? DEFAULT_MAX_LENGTH)) {
          problems.push(`field "${at(key)}" exceeds maxLength ${spec.maxLength ?? DEFAULT_MAX_LENGTH}`);
        } else out[key] = v;
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`field "${at(key)}" must be a number`);
        else out[key] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') problems.push(`field "${at(key)}" must be a boolean`);
        else out[key] = v;
        break;
      case 'array':
        if (!Array.isArray(v)) problems.push(`field "${at(key)}" must be an array`);
        else if (spec.maxItems !== undefined && v.length > spec.maxItems) {
          problems.push(`field "${at(key)}" exceeds maxItems ${spec.maxItems}`);
        } else {
          out[key] = v.map((item, i) => validateObject(spec.items ?? {}, item, `${at(key)}[${i}]`, problems));
        }
        break;
    }
  }
  return out;
}

export function validateData(t: CardTemplate, data: unknown): Record<string, unknown> {
  const problems: string[] = [];
  const out = validateObject(t.data, data ?? {}, '', problems);
  if (problems.length > 0) throw new TemplateError(problems);
  return out;
}

// ── fill ────────────────────────────────────────────────────────────────────

const EMPTY = Symbol('empty');

interface FillCtx {
  /** Options that carried a `$selected` key / whose `$selected` resolved to true. */
  keyed: WeakSet<object>;
  selected: WeakSet<object>;
  initialState: Record<string, string[]>;
}

function lookup(scope: Obj, dotted: string): unknown {
  let cur: unknown = scope;
  for (const seg of dotted.split('.')) {
    if (!isObj(cur) || !hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function substitute(s: string, scope: Obj, escape: boolean): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, p: string) => {
    const v = lookup(scope, p);
    const str = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    return escape ? escapeMrkdwn(str) : str;
  });
}

function isTextObject(n: Obj): n is Obj & { type: 'plain_text' | 'mrkdwn'; text: string } {
  return (n.type === 'plain_text' || n.type === 'mrkdwn') && typeof n.text === 'string';
}

function isEach(n: unknown): n is { $each: string; as: string; do: unknown } {
  return isObj(n) && hasOwn(n, '$each');
}

function fillArray(arr: unknown[], scope: Obj, ctx: FillCtx): unknown[] {
  const out: unknown[] = [];
  for (const member of arr) {
    if (isEach(member)) {
      const items = lookup(scope, member.$each);
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const f = fillNode(member.do, { ...scope, [member.as]: item }, ctx);
        if (f !== EMPTY) out.push(f);
      }
    } else {
      const f = fillNode(member, scope, ctx);
      if (f !== EMPTY) out.push(f);
    }
  }
  return out;
}

function fillObject(node: Obj, scope: Obj, ctx: FillCtx): unknown {
  if (isTextObject(node)) {
    const text = substitute(node.text, scope, node.type === 'mrkdwn');
    return text.trim() === '' ? EMPTY : { ...node, text };
  }

  const out: Obj = {};
  let keyed = false;
  let selected = false;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$selected') {
      keyed = true;
      selected = typeof v === 'string' && lookup(scope, v) === true;
      continue;
    }
    const f = fillNode(v, scope, ctx);
    if (f === EMPTY) return EMPTY;
    out[k] = f;
  }

  if (Array.isArray(out.fields) && out.fields.length === 0) delete out.fields;
  if (Array.isArray(out.options) && out.options.length === 0) return EMPTY;
  if (out.type === 'actions' && (!Array.isArray(out.elements) || out.elements.length === 0)) return EMPTY;
  if (out.type === 'section' && out.text === undefined && out.fields === undefined) return EMPTY;

  if (Array.isArray(out.options) && out.options.some((o) => isObj(o) && ctx.keyed.has(o))) {
    const picked = out.options.filter((o) => isObj(o) && ctx.selected.has(o));
    if (picked.length > 0) out.initial_options = picked;
    if (typeof out.action_id === 'string') {
      ctx.initialState[out.action_id] = picked.map((o) => String((o as Obj).value));
    }
  }
  if (keyed) {
    ctx.keyed.add(out);
    if (selected) ctx.selected.add(out);
  }
  return out;
}

function fillNode(node: unknown, scope: Obj, ctx: FillCtx): unknown {
  if (typeof node === 'string') return substitute(node, scope, false);
  if (Array.isArray(node)) return fillArray(node, scope, ctx);
  if (isObj(node)) return fillObject(node, scope, ctx);
  return node;
}

function checkLimits(node: unknown, where: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((m, i) => checkLimits(m, `${where}[${i}]`, problems));
    return;
  }
  if (!isObj(node)) return;
  if (isTextObject(node) && node.text.length > MAX_TEXT) {
    problems.push(`${where}: text is ${node.text.length} characters (max ${MAX_TEXT})`);
  }
  if (node.type === 'checkboxes' && Array.isArray(node.options) && node.options.length > MAX_CHECKBOX_OPTIONS) {
    problems.push(`${where}: ${node.options.length} checkbox options (max ${MAX_CHECKBOX_OPTIONS})`);
  }
  if (node.type === 'actions' && Array.isArray(node.elements) && node.elements.length > MAX_ACTIONS_ELEMENTS) {
    problems.push(`${where}: ${node.elements.length} elements in an actions block (max ${MAX_ACTIONS_ELEMENTS})`);
  }
  for (const [k, v] of Object.entries(node)) checkLimits(v, `${where}.${k}`, problems);
}

export function fillTemplate(
  t: CardTemplate,
  data: Record<string, unknown>,
): { text: string; blocks: unknown[]; initialState: Record<string, string[]> } {
  const ctx: FillCtx = { keyed: new WeakSet(), selected: new WeakSet(), initialState: {} };
  const blocks = fillArray(t.blocks, data, ctx);
  let text = substitute(t.text, data, true);
  if (text.trim() === '') text = t.name ?? 'card';

  const problems: string[] = [];
  if (blocks.length > MAX_BLOCKS) problems.push(`${blocks.length} blocks (max ${MAX_BLOCKS})`);
  checkLimits(blocks, 'blocks', problems);
  if (problems.length > 0) throw new TemplateError(problems);

  return { text, blocks, initialState: ctx.initialState };
}
