import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      { cardId: 'a b' },
      { cardId: 'x'.repeat(65) },
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

describe('update_card dataFile', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uc-root-')));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'uc-out-')));
  const prev = process.env.NANOCLAW_DATA_FILE_ROOT;
  beforeEach(() => {
    process.env.NANOCLAW_DATA_FILE_ROOT = root;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NANOCLAW_DATA_FILE_ROOT;
    else process.env.NANOCLAW_DATA_FILE_ROOT = prev;
  });
  const write = (dir: string, name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it('sends the file contents inline as data', async () => {
    const f = write(root, 'ok.json', JSON.stringify({ title: 'From file', n: 2 }));
    const result = await updateCard.handler({ cardId: 'c1', dataFile: f });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content).data).toEqual({ title: 'From file', n: 2 });
  });

  it('refuses data and dataFile together', async () => {
    const f = write(root, 'ok.json', '{}');
    const result = await updateCard.handler({ cardId: 'c1', data: {}, dataFile: f });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('says a missing file under the root does not exist', async () => {
    const result = await updateCard.handler({ cardId: 'c1', dataFile: join(root, 'missing.json') });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: dataFile does not exist');
  });

  it('refuses a file outside the root, a relative path, and a symlink that escapes it', async () => {
    const out = write(outsideDir, 'x.json', '{"secret":"s3cr3t"}');
    symlinkSync(out, join(root, 'link.json'));
    for (const p of [out, join(root, 'link.json'), 'ok.json', root]) {
      const result = await updateCard.handler({ cardId: 'c1', dataFile: p });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: dataFile must be a file under /workspace/agent/');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('refuses a file over 256 KB, bad JSON and an array, without echoing contents', async () => {
    const big = write(root, 'big.json', JSON.stringify({ a: 'x'.repeat(256 * 1024) }));
    const bad = write(root, 'bad.json', '{"secret": nope');
    const arr = write(root, 'arr.json', '[1,2]');
    const texts: string[] = [];
    for (const f of [big, bad, arr]) {
      const result = await updateCard.handler({ cardId: 'c1', dataFile: f });
      expect(result.isError).toBe(true);
      texts.push(result.content[0].text);
    }
    expect(texts[0]).toContain('256 KB');
    expect(texts[1]).toContain('not valid JSON');
    expect(texts[2]).toContain('JSON object');
    expect(texts.join('')).not.toContain('secret');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
