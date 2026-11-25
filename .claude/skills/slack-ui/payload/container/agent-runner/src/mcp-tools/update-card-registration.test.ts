/**
 * Guards the MCP tools barrel line. The barrel starts the MCP server when it
 * is imported, so this test reads it instead: `update_card` reaches the agent
 * only if index.ts imports './update-card.js'.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('update_card registration', () => {
  it('the MCP tools barrel imports the update_card tool', () => {
    const barrel = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    const lines = barrel.split('\n').map((line) => line.trim());
    expect(lines).toContain("import './update-card.js';");
  });
});
