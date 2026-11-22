import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wake-context.js', () => ({ registerWakeContext: vi.fn() }));
vi.mock('./settings.js', () => ({ isEnabled: vi.fn() }));
vi.mock('./a2a-rooms.js', () => ({ a2aRooms: vi.fn() }));
vi.mock('./status.js', () => ({ startWakeStatus: vi.fn() }));
vi.mock('../../channels/slack-lib.js', () => ({ botTokenKeyForInstance: (i: string) => `TOKEN_${i}` }));
vi.mock('../../env.js', async (orig) => ({
  ...(await orig<typeof import('../../env.js')>()),
  envValue: vi.fn((k: string) => (k === 'TOKEN_slack' ? 'xoxb-test' : undefined)),
}));

import type { WakeContextInput } from '../../wake-context.js';
import { a2aRooms } from './a2a-rooms.js';
import { isEnabled } from './settings.js';
import { startWakeStatus } from './status.js';
import { progressDisplayContext } from './wake.js';

function input(
  channelType = 'slack',
  platformId = 'slack:C1:1.2',
  threadId: string | null = 'slack:C1:5.5',
): WakeContextInput {
  return {
    agentGroup: { id: 'ag1' },
    session: { id: 's1', thread_id: threadId },
    mg: { channel_type: channelType, platform_id: platformId },
    wiring: {},
    created: false,
    trigger: { id: 'm1', timestamp: '2026-01-01T00:00:00.000Z' },
  } as unknown as WakeContextInput;
}

beforeEach(() => {
  vi.mocked(isEnabled).mockReset().mockResolvedValue(true);
  vi.mocked(a2aRooms).mockReset().mockReturnValue(new Set());
  vi.mocked(startWakeStatus).mockReset();
});

describe('progressDisplayContext', () => {
  it('gives an enabled Slack group the display block', async () => {
    const blocks = await progressDisplayContext(input());
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.key).toBe('display');
    expect(block.tag).toBe('progress-display');
    expect(block.about).toBe('How your progress is shown in this chat');
    expect(block.lines).toEqual([
      {
        sender: 'system',
        time: '2026-01-01T00:00:00.000Z',
        text: "People in this chat see your task list and your current step live, in a plan message and a status line. Do not report step progress in chat: no lines like 'Steps 1 and 2 are done', 'All four steps are done', or 'Now I will...'. Do not send any message until the work is done, unless you must ask a question you cannot continue without or the work has failed. Do not explain retries, corrections or changes of approach: just make them. Your final reply is the result itself, with no recap of which steps finished and no account of how you got there.",
      },
    ]);
  });

  it('gives a disabled group nothing', async () => {
    vi.mocked(isEnabled).mockResolvedValue(false);
    expect(await progressDisplayContext(input())).toEqual([]);
  });

  it('gives a non-Slack channel nothing', async () => {
    expect(await progressDisplayContext(input('telegram'))).toEqual([]);
  });

  it('gives an a2a room nothing', async () => {
    vi.mocked(a2aRooms).mockReturnValue(new Set(['C1']));
    expect(await progressDisplayContext(input())).toEqual([]);
  });

  it('gives nothing when isEnabled throws', async () => {
    vi.mocked(isEnabled).mockRejectedValue(new Error('db down'));
    expect(await progressDisplayContext(input())).toEqual([]);
  });

  it('starts the wake status in the session thread', async () => {
    await progressDisplayContext(input());
    expect(startWakeStatus).toHaveBeenCalledWith('s1', { token: 'xoxb-test', channel: 'C1', threadTs: '5.5' });
  });

  it('no wake status without a thread in this chat, or when the group is off', async () => {
    await progressDisplayContext(input('slack', 'slack:C1:1.2', null));
    await progressDisplayContext(input('slack', 'slack:C1:1.2', 'slack:C9:5.5'));
    vi.mocked(isEnabled).mockResolvedValue(false);
    await progressDisplayContext(input());
    expect(startWakeStatus).not.toHaveBeenCalled();
  });
});
