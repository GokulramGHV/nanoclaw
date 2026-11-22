import { describe, expect, it } from 'bun:test';
import { createHold } from './hold.js';

const row = (platformId: string, body: string) => ({ platformId, channelType: 'slack', threadId: null, body });

function setup(open: { value: boolean }) {
  const written: string[] = [];
  const logs: string[] = [];
  const hold = createHold({ stepsOpen: () => open.value, log: (m) => logs.push(m) });
  const offer = (platformId: string, body: string) =>
    hold.offer(row(platformId, body), async () => void written.push(body));
  return { hold, offer, written, logs };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('mid-task message hold', () => {
  it('does not take a message when no steps are open', () => {
    const { offer } = setup({ value: false });
    expect(offer('slack:C1', 'hi')).toBe(false);
  });

  it('drops narration when the final reply is written normally', async () => {
    const open = { value: true };
    const { hold, offer, written, logs } = setup(open);
    hold.onEvent({ type: 'turn_start', routing: {} as never, messages: [] });
    expect(offer('slack:C1', 'Still working, redoing it')).toBe(true);
    open.value = false;
    expect(offer('slack:C1', 'The result')).toBe(false);
    hold.onEvent({ type: 'turn_end', outcome: 'done' });
    await flush();
    expect(written).toEqual([]);
    expect(logs.join(' ')).toContain('dropped 1');
  });

  it('writes the last held message when nothing came after it', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent({ type: 'turn_start', routing: {} as never, messages: [] });
    offer('slack:C1', 'Step 1 done');
    offer('slack:C1', 'Which repo should I use?');
    hold.onEvent({ type: 'turn_end', outcome: 'done' });
    await flush();
    expect(written).toEqual(['Which repo should I use?']);
  });

  it('a message to another chat does not drop the held one', async () => {
    const open = { value: true };
    const { hold, offer, written } = setup(open);
    hold.onEvent({ type: 'turn_start', routing: {} as never, messages: [] });
    offer('slack:C1', 'Question for you');
    open.value = false;
    offer('slack:C2', 'note elsewhere');
    hold.onEvent({ type: 'turn_end', outcome: 'error' });
    await flush();
    expect(written).toEqual(['Question for you']);
  });

  it('a new turn settles anything left from a turn that never ended', async () => {
    const { hold, offer, written } = setup({ value: true });
    hold.onEvent({ type: 'turn_start', routing: {} as never, messages: [] });
    offer('slack:C1', 'left over');
    hold.onEvent({ type: 'turn_start', routing: {} as never, messages: [] });
    await flush();
    expect(written).toEqual(['left over']);
  });

  it('a failed write is logged, not thrown', async () => {
    const logs: string[] = [];
    const hold = createHold({ stepsOpen: () => true, log: (m) => logs.push(m) });
    hold.offer(row('slack:C1', 'x'), async () => {
      throw new Error('db down');
    });
    hold.onEvent({ type: 'turn_end', outcome: 'done' });
    await flush();
    expect(logs.join(' ')).toContain('db down');
  });
});
