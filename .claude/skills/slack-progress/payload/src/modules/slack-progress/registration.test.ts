import { describe, expect, it, vi } from 'vitest';

const actions: string[] = [];
const interceptors: unknown[] = [];
const migrations: string[] = [];

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: vi.fn((name: string) => void actions.push(name)),
  registerChatDeliveryInterceptor: vi.fn((fn: unknown) => void interceptors.push(fn)),
}));
vi.mock('../../db/migrations/index.js', () => ({
  registerMigration: vi.fn((m: { name: string }) => void migrations.push(m.name)),
}));
const wakeProviders: string[] = [];
vi.mock('../../wake-context.js', () => ({
  registerWakeContext: vi.fn((name: string) => void wakeProviders.push(name)),
}));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: vi.fn() }));
vi.mock('../../channels/slack-lib.js', () => ({ slackCall: vi.fn(), botTokenKeyForInstance: () => 'K' }));

describe('slack-progress index', () => {
  it('importing index registers progress and stream_append actions, the interceptor and the migration', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    await import('./index.js');
    expect(actions).toEqual(expect.arrayContaining(['progress', 'stream_append', 'stream_abort']));
    // The wake-status clear first (it never handles a reply), then the stream interceptor.
    expect(interceptors).toHaveLength(2);
    expect((interceptors[0] as { name: string }).name).toBe('clearWakeOnReply');
    expect(migrations).toContain('module:slack-progress:create-tables');
    expect(wakeProviders).toContain('slack-progress');
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 30000);
    timer.mockRestore();
  });
});
