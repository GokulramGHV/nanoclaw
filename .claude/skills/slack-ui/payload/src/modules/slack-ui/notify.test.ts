import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));

import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyCardFailure } from './notify.js';

const session = { id: 's-1', agent_group_id: 'ag-1' } as Session;
const write = vi.mocked(writeSessionMessage);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ id: 's-1' } as never);
});

describe('notifyCardFailure', () => {
  it('writes a system notice that records the message the card answered, then wakes the session', async () => {
    await notifyCardFailure(session, 'post_card failed: x', 'msg-7');
    expect(write).toHaveBeenCalledTimes(1);
    const [group, sess, msg] = write.mock.calls[0]!;
    expect(group).toBe('ag-1');
    expect(sess).toBe('s-1');
    expect(msg.id).toMatch(/^sys-/);
    expect(msg.kind).toBe('chat');
    expect(JSON.parse(msg.content)).toEqual({
      text: 'post_card failed: x',
      sender: 'system',
      senderId: 'system',
      cardInReplyTo: 'msg-7',
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('omits cardInReplyTo when the card answered nothing', async () => {
    await notifyCardFailure(session, 'post_card failed: y', undefined);
    expect(JSON.parse(write.mock.calls[0]![2].content)).toEqual({
      text: 'post_card failed: y',
      sender: 'system',
      senderId: 'system',
    });
  });
});
