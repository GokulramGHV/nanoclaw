import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// translateEvents feeds the progress seam: text deltas, tool starts and the
// TodoWrite list. The activity throttle must not change.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { registerProgressObserver, _resetProgressSeamForTesting } = await import('../progress-seam.js');
type ProgressEvent = import('../progress-seam.js').ProgressEvent;

let tmp: string;
let prevHome: string | undefined;
let nowSpy: ReturnType<typeof spyOn>;
let seen: ProgressEvent[];

beforeEach(() => {
  nowSpy = spyOn(Date, 'now').mockImplementation(() => 1_760_000_000_000);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-progress-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  seen = [];
  registerProgressObserver((e) => seen.push(e));
});

afterEach(() => {
  _resetProgressSeamForTesting();
  nowSpy.mockRestore();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(): Promise<string[]> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const types: string[] = [];
  for await (const e of q.events) types.push((e as { type: string }).type);
  return types;
}

function delta(text: string): unknown {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: `u-${text}`,
    session_id: 'sess-1',
  };
}

describe('translateEvents progress events', () => {
  it('translateEvents emits text_delta for content_block_delta text_delta stream events', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      delta('a'),
      delta('b'),
      delta('c'),
      // Not a text delta: ignored by the seam.
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } },
      },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'result', subtype: 'success', result: 'abc' },
    );
    const types = await drive();
    expect(seen).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_delta', text: 'c' },
    ]);
    // Frozen clock: init, one delta frame, result. Throttle unchanged.
    expect(types.filter((t) => t === 'activity')).toHaveLength(3);
  });

  it('translateEvents emits tool for each tool_use block and todos for TodoWrite input', async () => {
    const todos = [
      { content: 'Read the file', status: 'completed', activeForm: 'Reading the file' },
      { content: 'Write the fix', status: 'in_progress', activeForm: 'Writing the fix' },
    ];
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Working.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } },
            { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos } },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    );
    const types = await drive();
    expect(seen).toEqual([
      { type: 'tool', name: 'Bash', input: { command: 'ls', description: 'List files' } },
      { type: 'tool', name: 'TodoWrite', input: { todos } },
      { type: 'todos', todos },
    ]);
    // The text event is still yielded as before.
    expect(types.filter((t) => t === 'text')).toHaveLength(1);
  });
});
