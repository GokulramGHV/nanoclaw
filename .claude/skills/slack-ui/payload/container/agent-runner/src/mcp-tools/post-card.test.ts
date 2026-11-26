import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('passes replaces through and accepts it as an optional string in the schema', async () => {
    const props = postCard.tool.inputSchema.properties as Record<string, { type: string }>;
    expect(props.replaces.type).toBe('string');
    expect(postCard.tool.inputSchema.required).toEqual(['template']);

    await postCard.handler({ template: 'demo-request', replaces: ' earlier-card ' });
    expect(JSON.parse(getUndeliveredMessages()[0].content).replaces).toBe('earlier-card');
  });

  it('omits replaces when absent and rejects a non-string', async () => {
    await postCard.handler({ template: 'demo-request' });
    expect('replaces' in JSON.parse(getUndeliveredMessages()[0].content)).toBe(false);
    const result = await postCard.handler({ template: 'demo-request', replaces: 5 });
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('passes alsoToChannel through only when it is true', async () => {
    await postCard.handler({ template: 'demo-request', alsoToChannel: true });
    await postCard.handler({ template: 'demo-request', alsoToChannel: 'yes' });
    await postCard.handler({ template: 'demo-request' });
    const sent = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(sent[0].alsoToChannel).toBe(true);
    expect('alsoToChannel' in sent[1]).toBe(false);
    expect('alsoToChannel' in sent[2]).toBe(false);
  });
});

describe('post_card dataFile', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-root-')));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-out-')));
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
    const result = await postCard.handler({ template: 't', dataFile: f });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content).data).toEqual({ title: 'From file', n: 2 });
  });

  it('refuses data and dataFile together', async () => {
    const f = write(root, 'ok.json', '{}');
    const result = await postCard.handler({ template: 't', data: {}, dataFile: f });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('says a missing file under the root does not exist', async () => {
    const result = await postCard.handler({ template: 't', dataFile: join(root, 'missing.json') });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: dataFile does not exist');
  });

  it('refuses a file outside the root, a relative path, and a symlink that escapes it', async () => {
    const out = write(outsideDir, 'x.json', '{"secret":"s3cr3t"}');
    symlinkSync(out, join(root, 'link.json'));
    for (const p of [out, join(root, 'link.json'), 'ok.json', root]) {
      const result = await postCard.handler({ template: 't', dataFile: p });
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
      const result = await postCard.handler({ template: 't', dataFile: f });
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
