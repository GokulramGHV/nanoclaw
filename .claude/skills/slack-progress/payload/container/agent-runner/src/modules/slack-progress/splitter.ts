/**
 * Stream splitter. Reads the agent's text deltas and reports only the visible
 * parts: where a <message to="..."> block opens, the text inside it, and where
 * it closes. Text outside a block and <internal> spans are never reported.
 *
 * A "<" is held back until it is clear whether it starts a tag or is literal
 * text, so a tag split across two deltas is still recognised.
 */
export type SplitOp = { type: 'open'; to: string } | { type: 'text'; text: string } | { type: 'close' };

type Mode = 'outside' | 'message' | 'internal';

const OPEN_RE = /^<message\s+to="([^"]*)"\s*>/;
const CLOSE_RE = /^<\/message\s*>/;
const INT_OPEN_RE = /^<internal\s*>/;
const INT_CLOSE_RE = /^<\/internal\s*>/;
const MAX_TAG = 300;

type Tag =
  | { kind: 'open'; to: string; len: number }
  | { kind: 'close'; len: number }
  | { kind: 'iopen'; len: number }
  | { kind: 'iclose'; len: number };

function matchTag(rest: string, mode: Mode): Tag | null {
  if (mode === 'outside') {
    const o = OPEN_RE.exec(rest);
    if (o) return { kind: 'open', to: o[1], len: o[0].length };
  }
  if (mode === 'message') {
    const c = CLOSE_RE.exec(rest);
    if (c) return { kind: 'close', len: c[0].length };
  }
  if (mode !== 'internal') {
    const i = INT_OPEN_RE.exec(rest);
    if (i) return { kind: 'iopen', len: i[0].length };
  } else {
    const c = INT_CLOSE_RE.exec(rest);
    if (c) return { kind: 'iclose', len: c[0].length };
  }
  return null;
}

/** True when rest (which has no complete tag) could still become one. */
function couldBecomeTag(rest: string, mode: Mode): boolean {
  if (rest.length >= MAX_TAG) return false;
  const names =
    mode === 'outside' ? ['<message', '<internal'] : mode === 'message' ? ['</message', '<internal'] : ['</internal'];
  for (const n of names) {
    if (n.startsWith(rest)) return true;
    if (rest.startsWith(n) && !rest.includes('>')) {
      const tail = rest.slice(n.length);
      if (n === '<message') {
        if (/^\s+[^>]*$/.test(tail)) return true;
      } else if (/^\s*$/.test(tail)) {
        return true;
      }
    }
  }
  return false;
}

export function createSplitter(): { feed(delta: string): SplitOp[] } {
  let buf = '';
  let mode: Mode = 'outside';
  let afterInternal: Mode = 'outside';

  function feed(delta: string): SplitOp[] {
    buf += delta;
    const ops: SplitOp[] = [];
    for (;;) {
      if (buf === '') break;
      const idx = buf.indexOf('<');
      if (idx === -1) {
        if (mode === 'message') ops.push({ type: 'text', text: buf });
        buf = '';
        break;
      }
      if (idx > 0) {
        if (mode === 'message') ops.push({ type: 'text', text: buf.slice(0, idx) });
        buf = buf.slice(idx);
      }
      const tag = matchTag(buf, mode);
      if (tag) {
        buf = buf.slice(tag.len);
        if (tag.kind === 'open') {
          mode = 'message';
          ops.push({ type: 'open', to: tag.to });
        } else if (tag.kind === 'close') {
          mode = 'outside';
          ops.push({ type: 'close' });
        } else if (tag.kind === 'iopen') {
          afterInternal = mode;
          mode = 'internal';
        } else {
          mode = afterInternal;
        }
        continue;
      }
      if (couldBecomeTag(buf, mode)) break;
      if (mode === 'message') ops.push({ type: 'text', text: '<' });
      buf = buf.slice(1);
    }
    return ops;
  }

  return { feed };
}
