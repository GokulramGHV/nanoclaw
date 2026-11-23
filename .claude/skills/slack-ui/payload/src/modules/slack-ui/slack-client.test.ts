import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({
  slackCall: vi.fn(),
  SlackApiError: class extends Error {
    constructor(
      readonly step: string,
      message: string,
    ) {
      super(message);
      this.name = 'SlackApiError';
    }
  },
  botTokenKeyForInstance: (i: string) => `TOKEN_${i}`,
}));
vi.mock('../../env.js', async (orig) => ({ ...(await orig<typeof import('../../env.js')>()), envValue: vi.fn() }));

import { slackCall } from '../../channels/slack-lib.js';
import { envValue } from '../../env.js';
import { slackClientForInstance, slackClientForToken } from './slack-client.js';

const call = vi.mocked(slackCall);

beforeEach(() => {
  vi.clearAllMocks();
  call.mockResolvedValue({ ok: true, ts: '1.2' });
});

describe('slackClientForToken', () => {
  it('maps each kit method to its Slack method with the token', async () => {
    const c = slackClientForToken('xoxb-a');
    await c.chat.postMessage({ channel: 'C1' });
    await c.chat.update({ channel: 'C1', ts: '1' });
    await c.chat.delete({ channel: 'C1', ts: '1' });
    await c.chat.postEphemeral({ channel: 'C1', user: 'U1' });
    await c.views.open({ trigger_id: 't' });
    expect(call.mock.calls.map((x) => [x[0], x[1]])).toEqual([
      ['xoxb-a', 'chat.postMessage'],
      ['xoxb-a', 'chat.update'],
      ['xoxb-a', 'chat.delete'],
      ['xoxb-a', 'chat.postEphemeral'],
      ['xoxb-a', 'views.open'],
    ]);
    expect(call.mock.calls[0]![2]).toEqual({ channel: 'C1' });
  });

  it("returns Slack's response", async () => {
    expect(await slackClientForToken('xoxb-a').chat.postMessage({})).toMatchObject({ ts: '1.2' });
  });

  it('caches one client per token', () => {
    expect(slackClientForToken('xoxb-a')).toBe(slackClientForToken('xoxb-a'));
    expect(slackClientForToken('xoxb-a')).not.toBe(slackClientForToken('xoxb-b'));
  });

  it("exposes Slack's error code at err.data.error and keeps the error type and message", async () => {
    const { SlackApiError } =
      await vi.importActual<typeof import('../../channels/slack-lib.js')>('../../channels/slack-lib.js');
    call.mockRejectedValue(new SlackApiError('step', 'slack chat.update failed: invalid_blocks'));
    const err: any = await slackClientForToken('xoxb-a')
      .chat.update({})
      .catch((e) => e);
    expect(err.data).toEqual({ error: 'invalid_blocks' });
    expect(err.name).toBe('SlackApiError');
    expect(err.message).toBe('slack chat.update failed: invalid_blocks');
  });

  it('uses the whole message as the code when it has no "failed:" part', async () => {
    call.mockRejectedValue(new Error('boom'));
    const err: any = await slackClientForToken('xoxb-a')
      .views.open({})
      .catch((e) => e);
    expect(err.data).toEqual({ error: 'boom' });
  });
});

describe('usergroups.users.list wire format', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const reply = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it('sends form-encoded arguments with the bot token, not JSON, and not through slackCall', async () => {
    reply({ ok: true, users: ['U1', 'U2'] });
    const res = await slackClientForToken('xoxb-a').usergroups!.users.list({ usergroup: 'S0EXAMPLE' });
    expect(res.users).toEqual(['U1', 'U2']);
    expect(call).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://slack.com/api/usergroups.users.list');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toBe('Bearer xoxb-a');
    expect(init.body).toBe('usergroup=S0EXAMPLE');
  });

  it("exposes Slack's error at err.data.error", async () => {
    reply({ ok: false, error: 'missing_scope' });
    const err: any = await slackClientForToken('xoxb-a')
      .usergroups!.users.list({ usergroup: 'S1' })
      .catch((e) => e);
    expect(err.data).toEqual({ error: 'missing_scope' });
    expect(err.name).toBe('SlackApiError');
    expect(err.message).not.toContain('xoxb');
  });

  it('maps a network failure to an error too', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const err: any = await slackClientForToken('xoxb-a')
      .usergroups!.users.list({ usergroup: 'S1' })
      .catch((e) => e);
    expect(err.data.error).toBe('socket hang up');
  });
});

describe('slackClientForInstance', () => {
  it('builds a client from the instance bot token, or none when it is not set', () => {
    vi.mocked(envValue).mockImplementation((k) => (k === 'TOKEN_slack' ? 'xoxb-i' : undefined));
    expect(slackClientForInstance('slack')).toBe(slackClientForToken('xoxb-i'));
    expect(slackClientForInstance('other')).toBeUndefined();
  });
});
