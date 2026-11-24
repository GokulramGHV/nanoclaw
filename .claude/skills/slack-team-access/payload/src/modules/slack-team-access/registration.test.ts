import { describe, expect, it, vi } from 'vitest';

const migrations: string[] = [];
const interceptors: unknown[] = [];
vi.mock('../../db/migrations/index.js', () => ({
  registerMigration: vi.fn((m: { name: string }) => void migrations.push(m.name)),
}));
vi.mock('../../router.js', () => ({
  registerMessageInterceptor: vi.fn((fn: unknown) => void interceptors.push(fn)),
}));

describe('slack-team-access index', () => {
  it('registers the tables migration and one pre-route interceptor, and nothing else', async () => {
    await import('./index.js');
    expect(migrations).toEqual(['module:slack-team-access:create-tables']);
    expect(interceptors).toHaveLength(1);
  });
});
