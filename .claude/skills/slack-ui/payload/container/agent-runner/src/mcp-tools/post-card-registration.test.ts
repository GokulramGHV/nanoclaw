/**
 * Guards the MCP tools barrel line. The barrel starts the MCP server when it
 * is imported, so this test reads it instead: `post_card` reaches the agent
 * only if index.ts imports './post-card.js'.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('post_card registration', () => {
  it('the MCP tools barrel imports the post_card tool', () => {
    const barrel = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    const lines = barrel.split('\n').map((line) => line.trim());
    expect(lines).toContain("import './post-card.js';");
  });
});
