import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wake-context.js', () => ({ registerWakeContext: vi.fn() }));
vi.mock('./settings.js', () => ({ isEnabled: vi.fn() }));
vi.mock('./a2a-rooms.js', () => ({ a2aRooms: vi.fn() }));

import type { WakeContextInput } from '../../wake-context.js';
import { a2aRooms } from './a2a-rooms.js';
import { isEnabled } from './settings.js';
import { progressDisplayContext } from './wake.js';

function input(channelType = 'slack', platformId = 'slack:C1:1.2'): WakeContextInput {
  return {
    agentGroup: { id: 'ag1' },
    session: { id: 's1' },
    mg: { channel_type: channelType, platform_id: platformId },
    wiring: {},
    created: false,
    trigger: { id: 'm1', timestamp: '2026-01-01T00:00:00.000Z' },
  } as unknown as WakeContextInput;
}

beforeEach(() => {
  vi.mocked(isEnabled).mockReset().mockResolvedValue(true);
  vi.mocked(a2aRooms).mockReset().mockReturnValue(new Set());
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
        text: "People in this chat see your task list and your current step live, in a plan message and a status line. Do not report step progress in chat: no lines like 'Steps 1 and 2 are done', 'All four steps are done', or 'Now I will...'. Send a message mid-task only to ask a question or flag a real problem. Your final reply is the result itself, with no recap of which steps finished.",
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
});
