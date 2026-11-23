import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { CLAIMS_DIR, CLAIM_TTL_MS, claimMessage, isMessageClaimed, releaseMessage } from './message-claims.js';

const ids = ['plain', '../escape', 'a/b/c', '..', 'x'.repeat(500)];
afterEach(() => ids.forEach(releaseMessage));

describe('message claims', () => {
  it('claims and releases an id', () => {
    expect(isMessageClaimed('plain')).toBe(false);
    claimMessage('plain');
    expect(isMessageClaimed('plain')).toBe(true);
    releaseMessage('plain');
    expect(isMessageClaimed('plain')).toBe(false);
  });

  it('releasing an unclaimed id is harmless', () => {
    expect(() => releaseMessage('never-claimed')).not.toThrow();
  });

  it('keeps ids with slashes, dots and great length inside the claims directory', () => {
    for (const id of ids) claimMessage(id);
    for (const id of ids) expect(isMessageClaimed(id)).toBe(true);
    for (const name of fs.readdirSync(CLAIMS_DIR)) {
      expect(name).not.toContain('/');
      expect(path.resolve(CLAIMS_DIR, name)).toBe(path.join(CLAIMS_DIR, name));
    }
    expect(fs.existsSync(path.join(CLAIMS_DIR, '..', 'escape'))).toBe(false);
  });

  it('distinct ids do not share a claim', () => {
    claimMessage('a/b');
    expect(isMessageClaimed('a')).toBe(false);
    expect(isMessageClaimed('a_b')).toBe(false);
    releaseMessage('a/b');
  });

  it('ignores and removes a claim older than the expiry', () => {
    claimMessage('plain');
    const old = new Date(Date.now() - CLAIM_TTL_MS - 5000);
    const file = path.join(CLAIMS_DIR, Buffer.from('plain').toString('base64url'));
    fs.utimesSync(file, old, old);
    expect(isMessageClaimed('plain')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a claim that is still inside the expiry', () => {
    claimMessage('plain');
    expect(isMessageClaimed('plain', Date.now() + CLAIM_TTL_MS - 1000)).toBe(true);
  });
});
