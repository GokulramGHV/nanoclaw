import { expect, test } from 'bun:test';
import { _resetProgressSeamForTesting, decorateChatRow, emitProgress } from '../../progress-seam.js';

test('importing index registers one observer and one decorator', async () => {
  _resetProgressSeamForTesting();
  const calls: string[] = [];
  const orig = console.error;
  console.error = (m: unknown) => calls.push(String(m));
  try {
    await import('./index.js');
    // A turn_end with no open turn is ignored; no failure is logged by either observer.
    emitProgress({ type: 'turn_end', outcome: 'done' });
    expect(decorateChatRow({ platformId: 'p', channelType: 'slack', threadId: 't', body: 'x' })).toEqual({});
  } finally {
    console.error = orig;
  }
  expect(calls.filter((c) => c.includes('failed'))).toEqual([]);
});
