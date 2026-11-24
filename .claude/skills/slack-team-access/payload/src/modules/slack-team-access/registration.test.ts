import { beforeEach, describe, expect, it, vi } from 'vitest';

const migrations: string[] = [];
const state = { interceptors: 0, grants: 0, handlers: [] as unknown[], hook: true };
vi.mock('../../db/migrations/index.js', () => ({
  registerMigration: vi.fn((m: { name: string }) => void migrations.push(m.name)),
}));
vi.mock('../../router.js', () => ({
  registerMessageInterceptor: vi.fn(() => void state.interceptors++),
  get registerAccessGrant() {
    return state.hook ? vi.fn(() => void state.grants++) : undefined;
  },
}));
vi.mock('../../response-registry.js', () => ({
  registerResponseHandler: vi.fn((_fn: unknown, opts: unknown) => void state.handlers.push(opts)),
}));

describe('slack-team-access index', () => {
  beforeEach(() => {
    vi.resetModules();
    state.interceptors = 0;
    state.grants = 0;
    state.handlers = [];
    state.hook = true;
  });

  it('registers the tables migration, one interceptor, one access grant and a prepended response handler', async () => {
    await import('./index.js');
    expect(migrations).toContain('module:slack-team-access:create-tables');
    expect(state.interceptors).toBe(1);
    expect(state.grants).toBe(1);
    expect(state.handlers).toEqual([{ prepend: true }]);
  });

  it('refuses to start, registering nothing, when the router has no registerAccessGrant', async () => {
    state.hook = false;
    await expect(import('./index.js')).rejects.toThrow(/registerAccessGrant/);
    expect(state.interceptors).toBe(0);
    expect(state.handlers).toHaveLength(0);
  });
});
