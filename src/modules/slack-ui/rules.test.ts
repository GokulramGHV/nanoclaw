import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/slack-lib.js', () => ({ slackCall: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { slackCall } from '../../channels/slack-lib.js';
import { log } from '../../log.js';
import { canPress, createGroupCache, refusalText, ruleFor } from './rules.js';
import type { CardTemplate } from './template.js';

const call = vi.mocked(slackCall);
const tpl = (controls: CardTemplate['controls']): CardTemplate => ({
  version: 1,
  text: 't',
  data: {},
  controls,
  blocks: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ruleFor', () => {
  it('returns the template rule, defaulting to owner-only', () => {
    const t = tpl({ ok: { who: 'anyone' } });
    expect(ruleFor(t, 'ok')).toEqual({ who: 'anyone' });
    expect(ruleFor(t, 'missing')).toEqual({ who: 'owner' });
    expect(ruleFor(t, 'constructor')).toEqual({ who: 'owner' });
  });
});

describe('canPress', () => {
  const members = vi.fn(async () => ['U2']);
  it('owner rule: only the owner passes', async () => {
    expect(await canPress({ who: 'owner' }, 'U1', 'U1', members)).toBe(true);
    expect(await canPress({ who: 'owner' }, 'U2', 'U1', members)).toBe(false);
  });
  it('null owner fails everyone on owner rules', async () => {
    expect(await canPress({ who: 'owner' }, 'U1', null, members)).toBe(false);
  });
  it('anyone passes everyone', async () => {
    expect(await canPress({ who: 'anyone' }, 'U9', null, members)).toBe(true);
  });
  it('group rule: member passes, non-member fails', async () => {
    expect(await canPress({ who: { group: 'S1' } }, 'U2', 'U1', members)).toBe(true);
    expect(await canPress({ who: { group: 'S1' } }, 'U3', 'U1', members)).toBe(false);
    expect(members).toHaveBeenCalledWith('S1');
  });
  it('does not look up groups for non-group rules', async () => {
    const m = vi.fn(async () => []);
    await canPress({ who: 'owner' }, 'U1', 'U1', m);
    await canPress({ who: 'anyone' }, 'U1', 'U1', m);
    expect(m).not.toHaveBeenCalled();
  });
  it('empty clicker id is denied', async () => {
    expect(await canPress({ who: 'owner' }, '', '', members)).toBe(false);
  });
});

describe('refusalText', () => {
  it('formats each refusal', () => {
    expect(refusalText({ who: 'owner' }, 'U1')).toBe('Only <@U1> can do this.');
    expect(refusalText({ who: { group: 'S1' } }, 'U1')).toBe('Only people in <!subteam^S1> can do this.');
    expect(refusalText({ who: 'owner' }, null)).toBe('This card has no owner, so this control is locked.');
    expect(refusalText({ who: 'anyone' }, 'U1')).toBe('This control is not available.');
  });
});

describe('createGroupCache', () => {
  it('calls Slack once within the TTL, again after it', async () => {
    vi.useFakeTimers();
    call.mockResolvedValue({ ok: true, users: ['U1'] });
    const get = createGroupCache('xoxb-t', 1000);
    expect(await get('S1')).toEqual(['U1']);
    expect(await get('S1')).toEqual(['U1']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toBe('xoxb-t');
    expect(call.mock.calls[0]![1]).toBe('usergroups.users.list');
    expect(call.mock.calls[0]![2]).toEqual({ usergroup: 'S1' });
    vi.advanceTimersByTime(1001);
    await get('S1');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('caches per group', async () => {
    call.mockResolvedValue({ ok: true, users: [] });
    const get = createGroupCache('t');
    await get('S1');
    await get('S2');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('returns [] on error, does not cache it, warns once per group', async () => {
    call.mockRejectedValue(new Error('missing_scope'));
    const get = createGroupCache('t');
    expect(await get('S1')).toEqual([]);
    expect(await get('S1')).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await get('S2');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
  it('recovers after a failure', async () => {
    call.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ ok: true, users: ['U1'] });
    const get = createGroupCache('t');
    expect(await get('S1')).toEqual([]);
    expect(await get('S1')).toEqual(['U1']);
  });
  it('treats a malformed response as an empty, uncached result', async () => {
    call.mockResolvedValue({ ok: true });
    const get = createGroupCache('t');
    expect(await get('S1')).toEqual([]);
    await get('S1');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
