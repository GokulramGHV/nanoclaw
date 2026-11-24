/**
 * Card templates: load `cards/<name>.json` (version 2) from an agent group's
 * plugins together with the OpenUI Lang source it names, validate
 * agent-supplied data against the template's schema, and turn that data into
 * card state. Pure logic: the only I/O is `findTemplate`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Access, Rule } from 'slack-ui-kit';

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array';
  required?: boolean;
  /** string only; default 3000. */
  maxLength?: number;
  /** array only. */
  maxItems?: number;
  /** array only: the object schema of each element. */
  items?: Record<string, FieldSpec>;
  /** array only: a plain list of strings or numbers instead of objects (excludes `items`). `maxLength` caps each string. */
  of?: 'string' | 'number';
}

export interface CardTemplate {
  version: 2;
  /** Template name (set by parseTemplate). */
  name: string;
  data: Record<string, FieldSpec>;
  access?: Access;
  /** File name of the OpenUI Lang source, beside the JSON file. */
  openui: string;
  /** The OpenUI Lang source (set by findTemplate). */
  source?: string;
}

export class TemplateError extends Error {
  readonly problems: string[];
  constructor(problems: string[], options?: { cause?: unknown }) {
    super(problems.join('; '), options);
    this.name = 'TemplateError';
    this.problems = problems;
  }
}

/** A version 1 (JSON block) template. Its message is shown to the agent as is. */
export class OldTemplateFormatError extends TemplateError {
  constructor(name: string) {
    super([`template ${name} uses the old JSON block format; rewrite it in OpenUI Lang (see the slack-ui skill)`]);
    this.name = 'OldTemplateFormatError';
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPENUI_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.oui$/;
const DEFAULT_MAX_LENGTH = 3000;
const DEFAULT_MAX_ITEMS = 50;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Entity-escape `& < >`, so card data cannot add Slack markup. Strings only, recursively; keys are left alone. */
export function escapeEntities<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') as T;
  }
  if (Array.isArray(value)) return value.map((v) => escapeEntities(v)) as T;
  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeEntities(v)])) as T;
  }
  return value;
}

/**
 * The reverse of `escapeEntities` for text the agent reads: `&lt;` `&gt;` `&amp;` back to `< > &`, in that
 * order, once. Strings only, recursively; keys are left alone.
 */
export function decodeEntities<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') as T;
  }
  if (Array.isArray(value)) return value.map((v) => decodeEntities(v)) as T;
  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeEntities(v)])) as T;
  }
  return value;
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
    if (raw.maxLength !== undefined && type !== 'string' && !(type === 'array' && raw.of === 'string'))
      problems.push(`${at}.maxLength only applies to strings (or arrays of strings)`);
    if (raw.of !== undefined) {
      if (type !== 'array') problems.push(`${at}.of only applies to arrays`);
      else if (raw.of !== 'string' && raw.of !== 'number') problems.push(`${at}.of must be "string" or "number"`);
      else if (raw.items !== undefined) problems.push(`${at} cannot have both items and of`);
    }
    if (raw.maxItems !== undefined && type !== 'array') problems.push(`${at}.maxItems only applies to arrays`);
    if (raw.items !== undefined) {
      if (type !== 'array') problems.push(`${at}.items only applies to arrays`);
      else checkFieldSpecs(raw.items, `${at}.items`, problems);
    }
  }
}

function isRule(v: unknown): v is Rule {
  if (v === 'owner' || v === 'anyone') return true;
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  if (keys[0] === 'group') return typeof v.group === 'string' && v.group.length > 0;
  if (keys[0] === 'users') {
    return Array.isArray(v.users) && v.users.length > 0 && v.users.every((u) => typeof u === 'string' && u.length > 0);
  }
  return false;
}

const RULE_HELP = '"owner", "anyone", {"group": "<id>"} or {"users": ["<id>", ...]}';
const ACCESS_RULE_KEYS = ['default', 'buttons', 'inputs', 'feedback', 'forms'] as const;

function checkAccess(access: unknown, problems: string[]): void {
  if (!isObj(access)) {
    problems.push('access must be an object');
    return;
  }
  const allowed = new Set<string>([...ACCESS_RULE_KEYS, 'byId', 'lock']);
  for (const key of Object.keys(access)) {
    if (!allowed.has(key)) problems.push(`access.${key} is not a known setting`);
  }
  for (const key of ACCESS_RULE_KEYS) {
    if (access[key] !== undefined && !isRule(access[key])) problems.push(`access.${key} must be ${RULE_HELP}`);
  }
  if (access.byId !== undefined) {
    if (!isObj(access.byId)) problems.push('access.byId must be an object');
    else {
      for (const [id, rule] of Object.entries(access.byId)) {
        if (!isRule(rule)) problems.push(`access.byId.${id} must be ${RULE_HELP}`);
      }
    }
  }
  if (access.lock !== undefined) {
    const lock = access.lock;
    const ok =
      lock === 'buttons' ||
      lock === 'never' ||
      (isObj(lock) &&
        Object.keys(lock).length === 1 &&
        Array.isArray(lock.ids) &&
        lock.ids.every((i) => typeof i === 'string' && i.length > 0));
    if (!ok) problems.push('access.lock must be "buttons", "never" or {"ids": ["<control id>", ...]}');
  }
}

export function parseTemplate(json: string, name: string): CardTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new TemplateError([`template "${name}" is not valid JSON: ${(err as Error).message}`], { cause: err });
  }
  if (!isObj(raw)) throw new TemplateError([`template "${name}" must be a JSON object`]);
  if (raw.version === undefined || raw.version === 1) throw new OldTemplateFormatError(name);

  const problems: string[] = [];
  if (raw.version !== 2) problems.push('version must be 2');
  checkFieldSpecs(raw.data ?? {}, 'data', problems);
  if (raw.access !== undefined) checkAccess(raw.access, problems);
  if (typeof raw.openui !== 'string' || !OPENUI_FILE_RE.test(raw.openui)) {
    problems.push('openui must be the plain file name of a .oui file beside the template (no folders)');
  }
  if (problems.length > 0) throw new TemplateError(problems.map((p) => `template "${name}": ${p}`));

  return {
    version: 2,
    name,
    data: (raw.data ?? {}) as Record<string, FieldSpec>,
    ...(raw.access !== undefined ? { access: raw.access as Access } : {}),
    openui: raw.openui as string,
  };
}

/** A symlink could point a template at a host file; refuse it. A missing file passes through to the read. */
async function refuseSymlink(file: string, what: string): Promise<void> {
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new TemplateError([`${what} must not be a symlink`]);
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    // ENOENT and others: the read that follows reports them.
  }
}

export async function findTemplate(groupDir: string, name: string): Promise<{ template: CardTemplate; path: string }> {
  if (!NAME_RE.test(name)) throw new TemplateError([`invalid template name "${name}"`]);

  const pluginsDir = path.join(groupDir, 'plugins');
  let plugins: string[] = [];
  try {
    plugins = (await fs.readdir(pluginsDir)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new TemplateError([`cannot list plugins (${code ?? 'error'})`], { cause: err });
  }

  const found: Array<{ plugin: string; path: string; json: string }> = [];
  for (const plugin of plugins) {
    const file = path.join(pluginsDir, plugin, 'cards', `${name}.json`);
    try {
      await refuseSymlink(file, `card template "${name}" in plugin "${plugin}"`);
      found.push({ plugin, path: file, json: await fs.readFile(file, 'utf8') });
    } catch (err) {
      if (err instanceof TemplateError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new TemplateError([`cannot read card template "${name}" in plugin "${plugin}" (${code ?? 'error'})`], {
        cause: err,
      });
    }
  }

  if (found.length === 0) throw new TemplateError([`no card template "${name}" in any plugin`]);
  if (found.length > 1) {
    throw new TemplateError([
      `card template "${name}" is ambiguous: in plugins ${found.map((f) => f.plugin).join(', ')}`,
    ]);
  }
  const hit = found[0];
  let template: CardTemplate;
  try {
    template = parseTemplate(hit.json, name);
  } catch (err) {
    if (err instanceof OldTemplateFormatError) throw err;
    if (err instanceof TemplateError) {
      throw new TemplateError(
        err.problems.map((p) => `${p} (plugin "${hit.plugin}")`),
        { cause: err.cause ?? err },
      );
    }
    throw err;
  }
  const sourceFile = path.join(path.dirname(hit.path), template.openui);
  try {
    await refuseSymlink(sourceFile, `${template.openui} of card template "${name}"`);
    template.source = await fs.readFile(sourceFile, 'utf8');
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new TemplateError([`cannot read ${template.openui} for card template "${name}" (${code ?? 'error'})`], {
      cause: err,
    });
  }
  return { template, path: hit.path };
}

// ── validate ────────────────────────────────────────────────────────────────

function validateScalar(spec: FieldSpec, item: unknown, where: string, problems: string[]): unknown {
  if (spec.of === 'number') {
    if (typeof item !== 'number' || !Number.isFinite(item)) problems.push(`field "${where}" must be a number`);
    return item;
  }
  const max = spec.maxLength ?? DEFAULT_MAX_LENGTH;
  if (typeof item !== 'string') problems.push(`field "${where}" must be a string`);
  else if (item.length > max) problems.push(`field "${where}" exceeds maxLength ${max}`);
  return item;
}

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
        else if (v.length > (spec.maxItems ?? DEFAULT_MAX_ITEMS)) {
          problems.push(`field "${at(key)}" exceeds maxItems ${spec.maxItems ?? DEFAULT_MAX_ITEMS}`);
        } else {
          out[key] = spec.of
            ? v.map((item, i) => validateScalar(spec, item, `${at(key)}[${i}]`, problems))
            : v.map((item, i) => validateObject(spec.items ?? {}, item, `${at(key)}[${i}]`, problems));
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
