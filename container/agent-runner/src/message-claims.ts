/**
 * Message claims: a way for an MCP tool to keep one inbound message away from
 * the agent while the tool waits for it itself.
 *
 * The MCP server and the poll loop are separate processes in one container, so
 * a claim is an empty file under one directory in /tmp, named by a safe
 * encoding of the message id. A container restart clears /tmp, and with it every
 * claim.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLAIMS_DIR = '/tmp/nanoclaw-message-claims';

const MAX_NAME_LENGTH = 200;

/**
 * A claim older than this is stale and ignored: the longest wait is 300 s, plus
 * 30 s of margin. It covers an MCP process that was killed mid-wait (a `/clear`,
 * a SIGKILL) and never released its claim.
 */
export const CLAIM_TTL_MS = 330_000;

/** Ids with `/`, `..` or any other character cannot reach outside the claims directory. */
function claimPath(id: string): string {
  let name = Buffer.from(id, 'utf8').toString('base64url');
  if (name === '' || name.length > MAX_NAME_LENGTH) name = createHash('sha256').update(id).digest('hex');
  return path.join(CLAIMS_DIR, name);
}

export function claimMessage(id: string): void {
  fs.mkdirSync(CLAIMS_DIR, { recursive: true });
  fs.closeSync(fs.openSync(claimPath(id), 'w'));
}

export function releaseMessage(id: string): void {
  fs.rmSync(claimPath(id), { force: true });
}

export function isMessageClaimed(id: string, now: number = Date.now()): boolean {
  const file = claimPath(id);
  try {
    if (now - fs.statSync(file).mtimeMs <= CLAIM_TTL_MS) return true;
  } catch {
    return false;
  }
  fs.rmSync(file, { force: true });
  return false;
}
