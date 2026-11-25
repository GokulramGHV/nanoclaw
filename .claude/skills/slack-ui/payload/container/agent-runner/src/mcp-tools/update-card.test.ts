import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { updateCard } from './update-card.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('update_card', () => {
  it('writes one system row with the action content and acknowledges', async () => {
    const result = await updateCard.handler({ cardId: ' card-1 ', data: { title: 'Done' } });

    expect(result.isError).not.toBe(true);
    const rows = getUndeliveredMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    const content = JSON.parse(rows[0].content);
    expect(content.action).toBe('update_card');
    expect(content.cardId).toBe('card-1');
    expect(content.data).toEqual({ title: 'Done' });
    expect('inReplyTo' in content).toBe(true);
    expect(result.content[0].text).toBe('Card card-1 update queued.');
  });

  it('defaults data to an empty object', async () => {
    await updateCard.handler({ cardId: 'card-1' });
    expect(JSON.parse(getUndeliveredMessages()[0].content).data).toEqual({});
  });

  it('requires cardId in the schema', () => {
    expect(updateCard.tool.inputSchema.required).toEqual(['cardId']);
  });

  it('rejects a bad cardId or data and writes nothing', async () => {
    for (const args of [
      { cardId: '' },
      { cardId: '  ' },
      { cardId: 5 },
      {},
      { cardId: 'ok', data: null },
      { cardId: 'ok', data: [1] },
      { cardId: 'ok', data: 'str' },
    ]) {
      const result = await updateCard.handler(args as Record<string, unknown>);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
