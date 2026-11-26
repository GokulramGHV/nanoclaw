import { describe, expect, it } from 'vitest';

import { parseTaskContent } from './task-content.js';

const route = { channelType: 'slack', platformId: 'C1', threadId: '111.222' };

describe('parseTaskContent originRoute', () => {
  it('reads a valid route', () => {
    expect(parseTaskContent(JSON.stringify({ prompt: 'p', originRoute: route })).originRoute).toEqual(route);
  });

  it('reads a route without a thread as a null thread', () => {
    const { threadId: _omit, ...noThread } = route;
    expect(parseTaskContent(JSON.stringify({ prompt: 'p', originRoute: noThread })).originRoute).toEqual({
      ...noThread,
      threadId: null,
    });
    expect(
      parseTaskContent(JSON.stringify({ originRoute: { ...route, threadId: null } })).originRoute?.threadId,
    ).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['null', { originRoute: null }],
    ['a string', { originRoute: 'slack' }],
    ['no platform', { originRoute: { channelType: 'slack', threadId: null } }],
    ['a numeric channel', { originRoute: { ...route, channelType: 5 } }],
    ['a numeric thread', { originRoute: { ...route, threadId: 5 } }],
  ])('gives null when the route is %s', (_label, content) => {
    expect(parseTaskContent(JSON.stringify({ prompt: 'p', ...content })).originRoute).toBeNull();
  });

  it('gives null for legacy plain-string content', () => {
    expect(parseTaskContent('remind me')).toMatchObject({ prompt: 'remind me', originRoute: null });
  });
});
