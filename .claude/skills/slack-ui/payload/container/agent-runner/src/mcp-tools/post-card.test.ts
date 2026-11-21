import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { postCard } from './post-card.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('post_card', () => {
  it('writes one system row with the action content and returns the card id', async () => {
    const result = await postCard.handler({ template: ' demo-request ', data: { title: 'Hello' } });

    expect(result.isError).not.toBe(true);
    const rows = getUndeliveredMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    const content = JSON.parse(rows[0].content);
    expect(content.action).toBe('post_card');
    expect(content.template).toBe('demo-request');
    expect(content.data).toEqual({ title: 'Hello' });
    expect(content.cardId).toMatch(/^[0-9a-f-]{36}$/);
    expect('threadId' in content).toBe(true);
    expect('inReplyTo' in content).toBe(true);
    expect(result.content[0].text).toBe(
      `Card ${content.cardId} queued. Clicks arrive later as card_event messages; don't wait for them.`,
    );
  });

  it('defaults data to an empty object', async () => {
    await postCard.handler({ template: 'demo-request' });
    expect(JSON.parse(getUndeliveredMessages()[0].content).data).toEqual({});
  });

  it('rejects a bad template or data and writes nothing', async () => {
    for (const args of [
      { template: '' },
      { template: '   ' },
      { template: 5 },
      {},
      { template: 'x'.repeat(101) },
      { template: 'ok', data: null },
      { template: 'ok', data: [1] },
      { template: 'ok', data: 'str' },
    ]) {
      const result = await postCard.handler(args as Record<string, unknown>);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
