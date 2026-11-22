import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  chatRowDecoratorKeys,
  _resetProgressSeamForTesting,
  holdChatRow,
  registerChatRowHold,
  decorateChatRow,
  emitProgress,
  registerChatRowDecorator,
  registerProgressObserver,
  type ProgressEvent,
} from './progress-seam.js';

const ROW = { platformId: 'chan-1', channelType: 'slack', threadId: 't-1', body: 'hello' };

afterEach(() => _resetProgressSeamForTesting());

describe('progress observer', () => {
  it('emitProgress with no observer is a no-op', () => {
    expect(() => emitProgress({ type: 'text_delta', text: 'x' })).not.toThrow();
  });

  it('observers receive events in order', () => {
    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    registerProgressObserver((e) => a.push(e));
    registerProgressObserver((e) => b.push(e));
    const events: ProgressEvent[] = [
      { type: 'text_delta', text: 'one' },
      { type: 'tool', name: 'Read', input: { file_path: '/x' } },
      { type: 'turn_end', outcome: 'done' },
    ];
    for (const e of events) emitProgress(e);
    expect(a).toEqual(events);
    expect(b).toEqual(events);
  });

  it('a throwing observer does not stop others or throw', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const seen: ProgressEvent[] = [];
      registerProgressObserver(() => {
        throw new Error('boom');
      });
      registerProgressObserver((e) => seen.push(e));
      expect(() => emitProgress({ type: 'turn_end', outcome: 'error' })).not.toThrow();
      expect(seen).toEqual([{ type: 'turn_end', outcome: 'error' }]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('chat row decorator', () => {
  it('decorateChatRow merges decorator fields', () => {
    registerChatRowDecorator(() => ({ stream: 's-1' }));
    registerChatRowDecorator((row) => (row.channelType === 'slack' ? { extra: 2 } : null));
    registerChatRowDecorator(() => null);
    expect(decorateChatRow(ROW)).toEqual({ stream: 's-1', extra: 2 });
  });

  it('decorateChatRow never lets a decorator replace text', () => {
    registerChatRowDecorator(() => ({ text: 'replaced', stream: 's-1' }));
    const fields = decorateChatRow(ROW);
    expect('text' in fields).toBe(false);
    expect(fields).toEqual({ stream: 's-1' });
  });

  it('decorateChatRow returns {} with no decorator', () => {
    expect(decorateChatRow(ROW)).toEqual({});
  });

  it('a throwing decorator is skipped', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerChatRowDecorator(() => {
        throw new Error('boom');
      });
      registerChatRowDecorator(() => ({ stream: 's-2' }));
      expect(decorateChatRow(ROW)).toEqual({ stream: 's-2' });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('chatRowDecoratorKeys is empty with no decorator and lists added keys, never text', () => {
    expect(chatRowDecoratorKeys().size).toBe(0);
    registerChatRowDecorator(() => ({ stream: 's-3', text: 'x' }));
    decorateChatRow(ROW);
    expect([...chatRowDecoratorKeys()]).toEqual(['stream']);
  });
});

describe('chat row hold', () => {
  const row = { platformId: 'slack:C1', channelType: 'slack', threadId: null, body: 'hi' };
  const write = async () => {};

  it('nothing registered: no hold', () => {
    expect(holdChatRow(row, write)).toBe(false);
  });

  it('a hold that takes the row gets the write function', () => {
    let got: unknown = null;
    registerChatRowHold((_r, w) => {
      got = w;
      return true;
    });
    expect(holdChatRow(row, write)).toBe(true);
    expect(got).toBe(write);
  });

  it('a throwing hold counts as no hold', () => {
    registerChatRowHold(() => {
      throw new Error('boom');
    });
    expect(holdChatRow(row, write)).toBe(false);
  });
});
