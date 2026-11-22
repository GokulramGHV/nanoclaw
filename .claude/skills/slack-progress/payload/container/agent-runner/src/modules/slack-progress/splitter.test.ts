import { describe, expect, test } from 'bun:test';
import { createSplitter, type SplitOp } from './splitter.js';

/** Normalise: merge adjacent text ops so chunking does not matter. */
function norm(ops: SplitOp[]): SplitOp[] {
  const out: SplitOp[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (o.type === 'text' && last?.type === 'text') last.text += o.text;
    else out.push({ ...o });
  }
  return out;
}

function everySplit(input: string): SplitOp[][] {
  const results: SplitOp[][] = [];
  for (let i = 0; i <= input.length; i++) {
    const s = createSplitter();
    results.push(norm([...s.feed(input.slice(0, i)), ...s.feed(input.slice(i))]));
  }
  return results;
}

function expectAll(input: string, expected: SplitOp[]) {
  for (const got of everySplit(input)) expect(got).toEqual(expected);
}

describe('splitter', () => {
  test('plain block', () => {
    expectAll('<message to="x">hello</message>', [
      { type: 'open', to: 'x' },
      { type: 'text', text: 'hello' },
      { type: 'close' },
    ]);
  });

  test('tag split across chunks', () => {
    const s = createSplitter();
    const ops = [...s.feed('<mess'), ...s.feed('age to="x'), ...s.feed('">hi</mes'), ...s.feed('sage>')];
    expect(norm(ops)).toEqual([{ type: 'open', to: 'x' }, { type: 'text', text: 'hi' }, { type: 'close' }]);
  });

  test('text outside message emits nothing', () => {
    expectAll('thinking <b>aloud</b> here', []);
  });

  test('internal span inside a message is dropped', () => {
    expectAll('<message to="x">a<internal>secret</internal>b</message>', [
      { type: 'open', to: 'x' },
      { type: 'text', text: 'ab' },
      { type: 'close' },
    ]);
  });

  test('a < b inside a message is kept as text', () => {
    expectAll('<message to="x">a < b</message>', [
      { type: 'open', to: 'x' },
      { type: 'text', text: 'a < b' },
      { type: 'close' },
    ]);
  });

  test('<https://example.com|link> is kept as text', () => {
    expectAll('<message to="x">see <https://example.com|link></message>', [
      { type: 'open', to: 'x' },
      { type: 'text', text: 'see <https://example.com|link>' },
      { type: 'close' },
    ]);
  });

  test('two blocks give two open/close pairs', () => {
    expectAll('<message to="a">one</message> between <message to="b">two</message>', [
      { type: 'open', to: 'a' },
      { type: 'text', text: 'one' },
      { type: 'close' },
      { type: 'open', to: 'b' },
      { type: 'text', text: 'two' },
      { type: 'close' },
    ]);
  });

  test('an unclosed block at end emits open and text but no close', () => {
    expectAll('<message to="x">partial', [
      { type: 'open', to: 'x' },
      { type: 'text', text: 'partial' },
    ]);
  });
});
