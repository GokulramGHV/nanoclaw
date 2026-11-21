/**
 * Who may press a card control. Closed by default: a control with no rule is
 * owner-only, and anything we cannot verify (no owner, group lookup failure)
 * denies the press. Rules come only from the template.
 */
import { slackCall } from '../../channels/slack-lib.js';
import { log } from '../../log.js';
import type { CardTemplate, ControlRule } from './template.js';

const OWNER_ONLY: ControlRule = Object.freeze({ who: 'owner' });

export function ruleFor(t: CardTemplate, control: string): ControlRule {
  const rules = t.controls;
  if (!Object.prototype.hasOwnProperty.call(rules, control)) return OWNER_ONLY;
  return rules[control] ?? OWNER_ONLY;
}

/** User ids are raw Slack ids (`U…`). `groupMembers` is only called for group rules. */
export async function canPress(
  rule: ControlRule,
  userId: string,
  ownerUserId: string | null,
  groupMembers: (groupId: string) => Promise<string[]>,
): Promise<boolean> {
  if (!userId) return false;
  if (rule.who === 'anyone') return true;
  if (rule.who === 'owner') return ownerUserId !== null && ownerUserId !== '' && userId === ownerUserId;
  if (typeof rule.who === 'object' && rule.who !== null && typeof rule.who.group === 'string') {
    return (await groupMembers(rule.who.group)).includes(userId);
  }
  return false;
}

export function refusalText(rule: ControlRule, ownerUserId: string | null): string {
  if (rule.who === 'owner') {
    return ownerUserId ? `Only <@${ownerUserId}> can do this.` : 'This card has no owner, so this control is locked.';
  }
  if (typeof rule.who === 'object' && rule.who !== null) {
    return `Only people in <!subteam^${rule.who.group}> can do this.`;
  }
  return 'This control is not available.';
}

/**
 * Cached `usergroups.users.list` lookup. On any Slack error (e.g.
 * `missing_scope`) returns [] so the press is denied; failures are not cached
 * and warn once per group per cache instance.
 */
export function createGroupCache(token: string, ttlMs = 60_000): (groupId: string) => Promise<string[]> {
  const cache = new Map<string, { users: string[]; expires: number }>();
  const warned = new Set<string>();
  return async (groupId) => {
    const hit = cache.get(groupId);
    if (hit && hit.expires > Date.now()) return hit.users;
    try {
      const res = await slackCall(token, 'usergroups.users.list', { usergroup: groupId }, 'slack-ui-group-members');
      if (!Array.isArray(res.users)) throw new Error('usergroups.users.list returned no users array');
      const users = res.users.filter((u): u is string => typeof u === 'string');
      cache.set(groupId, { users, expires: Date.now() + ttlMs });
      return users;
    } catch (err) {
      if (!warned.has(groupId)) {
        warned.add(groupId);
        log.warn('Slack user group lookup failed; denying group-restricted presses', {
          group: groupId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return [];
    }
  };
}
