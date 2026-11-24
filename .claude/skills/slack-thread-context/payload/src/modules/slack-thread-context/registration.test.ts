import { describe, expect, it, vi } from 'vitest';

const migrations: string[] = [];
const providers: string[] = [];
vi.mock('../../db/migrations/index.js', () => ({
  registerMigration: vi.fn((m: { name: string }) => void migrations.push(m.name)),
}));
vi.mock('../../wake-context.js', () => ({
  registerWakeContext: vi.fn((name: string) => void providers.push(name)),
}));
vi.mock('../../session-manager.js', () => ({ sessionDir: vi.fn(), withExistingMailboxSession: vi.fn() }));

describe('slack-thread-context index', () => {
  it('registers the settings migration and the wake-context provider', async () => {
    await import('./index.js');
    expect(migrations).toContain('module:slack-thread-context:create-settings');
    expect(providers).toContain('slack-thread-context');
  });
});
