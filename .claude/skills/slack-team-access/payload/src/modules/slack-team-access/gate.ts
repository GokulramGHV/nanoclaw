/**
 * Slack team access: a pre-route interceptor for Slack instances that have a
 * `slack_team_access` row. For those instances only, it
 *   1. refuses Slack Connect (externally shared) channels,
 *   2. admits only members of one Slack user group to the configured agent
 *      group's channels and DMs, and
 *   3. wires an unwired channel or DM to that agent group when a member tags
 *      the bot or DMs it.
 * Returning true consumes the message (nothing reaches any agent); returning
 * false lets the router carry on. Every error and every failed Slack lookup
 * consumes the message: this is access control and fails closed. An instance
 * with no row, and any channel wired only to other agent groups, are untouched.
 */
import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { resolveUnknownSenderPolicy, resolveWiringDefaults } from '../../channels/channel-defaults.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getPendingQuestion, getSession } from '../../db/sessions.js';
import type { ResponseOutcome, ResponsePayload } from '../../response-registry.js';
import type { MessagingGroupAgent } from '../../types.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import {
  createMessagingGroupAgent,
  createMessagingGroupIfAbsent,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from '../../db/messaging-groups.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';
import { getConfig, isAutoWired, type TeamAccessConfig } from './config.js';
import { fetchIsExtShared, fetchUserGroupMembers, postEphemeralNote } from './slack-api.js';

export const EXTERNAL_TTL_MS = 10 * 60 * 1000;
export const MEMBERS_TTL_MS = 60 * 1000;
export const NOTE_INTERVAL_MS = 60 * 60 * 1000;
export const GROUP_TIMEOUT_MS = 1500;
export const EXTERNAL_TIMEOUT_MS = 3000;
const NOTE_TIMEOUT_MS = 3000;
const INFLIGHT_MAX_MS = 5000;

export interface TeamAccessDeps {
  token(instance: string): string | undefined;
  isExtShared(token: string, channel: string, timeoutMs: number): Promise<boolean>;
  userGroupMembers(token: string, usergroup: string, timeoutMs: number): Promise<string[]>;
  postEphemeral(token: string, channel: string, user: string, text: string, threadTs?: string): Promise<void>;
  now(): number;
  groupTimeoutMs: number;
  externalTimeoutMs: number;
}

export const realDeps: TeamAccessDeps = {
  token: (instance) => envValue(botTokenKeyForInstance(instance)) || undefined,
  isExtShared: fetchIsExtShared,
  userGroupMembers: fetchUserGroupMembers,
  postEphemeral: postEphemeralNote,
  now: () => Date.now(),
  groupTimeoutMs: GROUP_TIMEOUT_MS,
  externalTimeoutMs: EXTERNAL_TIMEOUT_MS,
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function parseContent(raw: string): Record<string, any> {
  try {
    const c = JSON.parse(raw);
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

/**
 * The sender's raw platform handle: the bridge's flat senderId (which the permissions module reads
 * first too), else the nested author.userId. Never `sender`, which is a display name.
 */
function rawSender(content: Record<string, any>): string | undefined {
  return [content.senderId, content.author?.userId].find((v): v is string => typeof v === 'string' && v !== '');
}

const SLACK_TS = /^\d+\.\d+$/;
function threadTsOf(threadId: string | null): string | undefined {
  const parts = threadId?.split(':');
  return parts && parts.length === 3 && SLACK_TS.test(parts[2]) ? parts[2] : undefined;
}

class TtlCache<T> {
  private values = new Map<string, { at: number; value: T }>();
  private inflight = new Map<string, { at: number; p: Promise<T> }>();
  constructor(
    private ttl: number,
    private now: () => number,
  ) {}
  /** A fresh cached value, or the loader's (shared by concurrent callers). Failures are never cached. */
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && this.now() - hit.at < this.ttl) return Promise.resolve(hit.value);
    // A load still pending after INFLIGHT_MAX_MS is abandoned (its result is ignored), never waited on.
    const pending = this.inflight.get(key);
    if (pending && this.now() - pending.at < INFLIGHT_MAX_MS) return pending.p;
    const entry: { at: number; p: Promise<T> } = {
      at: this.now(),
      p: load().then((value) => {
        this.values.set(key, { at: this.now(), value });
        if (this.values.size > 5000) this.values.delete(this.values.keys().next().value as string);
        return value;
      }),
    };
    this.inflight.set(key, entry);
    const clear = () => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    entry.p.then(clear, clear);
    return entry.p;
  }
}

export function createTeamAccess(deps: TeamAccessDeps = realDeps) {
  const external = new TtlCache<boolean>(EXTERNAL_TTL_MS, deps.now);
  const members = new TtlCache<Set<string>>(MEMBERS_TTL_MS, deps.now);
  const notes = new Map<string, number>();

  function tokenOrThrow(instance: string): string {
    const t = deps.token(instance);
    if (!t) throw new Error(`no bot token for instance ${instance}`);
    return t;
  }

  async function drop(
    event: InboundEvent,
    cfg: TeamAccessConfig,
    mg: MessagingGroup | undefined,
    userId: string | null,
    reason: string,
    content: Record<string, any>,
  ): Promise<void> {
    log.info('MESSAGE DROPPED — slack team access', { reason, instance: cfg.instance, platformId: event.platformId });
    try {
      await recordDroppedMessage({
        channel_type: event.channelType,
        platform_id: event.platformId,
        user_id: userId,
        sender_name: typeof content.sender === 'string' ? content.sender : (content.author?.userName ?? null),
        reason,
        messaging_group_id: mg?.id ?? null,
        agent_group_id: cfg.agent_group_id,
      });
    } catch (err) {
      log.error('Slack team access: recording the drop failed', { err });
    }
  }

  /** At most one note per kind, sender and channel per hour. Never throws. */
  async function notify(
    kind: 'external' | 'refusal',
    cfg: TeamAccessConfig,
    event: InboundEvent,
    channel: string,
    sender: string | undefined,
  ): Promise<void> {
    if (!sender) return;
    const key = `${kind}|${cfg.instance}|${channel}|${sender}`;
    const last = notes.get(key);
    if (last !== undefined && deps.now() - last < NOTE_INTERVAL_MS) return;
    notes.set(key, deps.now());
    if (notes.size > 5000) notes.delete(notes.keys().next().value as string);
    try {
      const token = tokenOrThrow(cfg.instance);
      await withTimeout(
        deps.postEphemeral(
          token,
          channel,
          sender,
          kind === 'external' ? cfg.external_note : cfg.refusal_note,
          threadTsOf(event.threadId),
        ),
        NOTE_TIMEOUT_MS,
        'ephemeral note',
      );
    } catch (err) {
      log.warn('Slack team access: could not send the note', { kind, err });
    }
  }

  /** The sender's membership of the user group, or throws (lookup failed, timed out). */
  async function isGroupMember(cfg: TeamAccessConfig, sender: string): Promise<boolean> {
    const token = tokenOrThrow(cfg.instance);
    const set = await withTimeout(
      members.get(
        `${cfg.instance}|${cfg.user_group_id}`,
        async () => new Set(await deps.userGroupMembers(token, cfg.user_group_id!, deps.groupTimeoutMs)),
      ),
      deps.groupTimeoutMs,
      'user group lookup',
    );
    return set.has(sender);
  }

  /** Create the messaging group if needed and wire it to the configured agent group. Throws on any failure. */
  async function autoWire(
    event: InboundEvent,
    cfg: TeamAccessConfig,
    found: { mg: MessagingGroup } | null,
  ): Promise<MessagingGroup> {
    const agentGroup = await getAgentGroup(cfg.agent_group_id);
    if (!agentGroup) throw new Error(`configured agent group ${cfg.agent_group_id} does not exist`);
    const instance = event.instance ?? event.channelType;
    const isGroup = event.message.isGroup === true;
    const defaults = resolveWiringDefaults(instance, isGroup, agentGroup.name, event.channelType);
    let mg = found?.mg;
    if (!mg) {
      await createMessagingGroupIfAbsent({
        id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel_type: event.channelType,
        platform_id: event.platformId,
        instance,
        name: null,
        is_group: isGroup ? 1 : 0,
        unknown_sender_policy: resolveUnknownSenderPolicy(instance, isGroup, event.channelType),
        denied_at: null,
        created_at: new Date().toISOString(),
      });
      mg = (await getMessagingGroupWithAgentCount(event.channelType, event.platformId, instance))?.mg;
      if (!mg) throw new Error('messaging group disappeared after insert');
    }
    const at = new Date().toISOString();
    const wiringId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await getDb().transaction(async () => {
        await createMessagingGroupAgent({
          id: wiringId,
          messaging_group_id: mg!.id,
          agent_group_id: cfg.agent_group_id,
          engage_mode: defaults.engage_mode,
          engage_pattern: defaults.engage_pattern,
          // 'known' keeps anyone outside the user group (the permissions gate admits members only);
          // 'drop' means chatter nobody tagged is never read.
          sender_scope: 'known',
          ignored_message_policy: 'drop',
          session_mode: defaults.session_mode,
          threads: defaults.threads,
          priority: 0,
          created_at: at,
        });
        // A row left by a wiring that was since deleted is replaced, never a conflict.
        await getDb().run(
          `INSERT INTO slack_team_access_wired (messaging_group_id, agent_group_id, wiring_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(messaging_group_id) DO UPDATE SET
             agent_group_id = excluded.agent_group_id, wiring_id = excluded.wiring_id, created_at = excluded.created_at`,
          mg!.id,
          cfg.agent_group_id,
          wiringId,
          at,
        );
      });
    } catch (err) {
      // A concurrent first tag may have wired it already; anything else is a real failure.
      const wired = (await getMessagingGroupAgents(mg.id)).some((a) => a.agent_group_id === cfg.agent_group_id);
      if (!wired) throw err;
    }
    log.info('Slack team access: channel auto-wired', {
      messagingGroupId: mg.id,
      agentGroupId: cfg.agent_group_id,
      engageMode: defaults.engage_mode,
    });
    return mg;
  }

  /** Slack Connect refusal. True when the message was dropped (shared, or the lookup failed). */
  async function externalRefused(
    event: InboundEvent,
    cfg: TeamAccessConfig,
    mg: MessagingGroup | undefined,
    userId: string | null,
    sender: string | undefined,
    channel: string,
    addressed: boolean,
    content: Record<string, any>,
  ): Promise<boolean> {
    if (!cfg.refuse_external) return false;
    let shared = true;
    let failed = false;
    try {
      const token = tokenOrThrow(cfg.instance);
      shared = await withTimeout(
        external.get(`${cfg.instance}|${channel}`, () => deps.isExtShared(token, channel, deps.externalTimeoutMs)),
        deps.externalTimeoutMs,
        'conversations.info',
      );
    } catch (err) {
      failed = true;
      log.warn('Slack team access: shared-channel lookup failed, refusing', { channel, err });
    }
    if (!shared) return false;
    await drop(event, cfg, mg, userId, failed ? 'slack_external_lookup_failed' : 'slack_external_channel', content);
    if (addressed) await notify('external', cfg, event, channel, sender);
    return true;
  }

  async function decide(event: InboundEvent, instance: string): Promise<boolean> {
    const cfg = await getConfig(instance);
    if (!cfg) return false; // default off

    const content = parseContent(event.message.content);
    const handle = rawSender(content);
    const sender = handle?.split(':').pop();
    const userId = handle ? (handle.includes(':') ? handle : `${event.channelType}:${handle}`) : null;
    const channel = event.platformId.split(':').pop() ?? '';
    const addressed = event.message.isMention === true || event.message.isGroup === false;

    const found = await getMessagingGroupWithAgentCount(event.channelType, event.platformId, instance);
    const wirings = found && found.agentCount > 0 ? await getMessagingGroupAgents(found.mg.id) : [];
    const unwired = wirings.length === 0;
    const wiredToConfigured = wirings.some((w) => w.agent_group_id === cfg.agent_group_id);

    if (unwired && !addressed) return false; // the router drops chatter in unwired channels silently
    if (unwired && found?.mg.denied_at) return false; // denied by the owner stays denied

    // 1. Slack Connect refusal, before anything else, on every event the checks above did not skip
    //    (channels wired only to another agent group included).
    if (await externalRefused(event, cfg, found?.mg, userId, sender, channel, addressed, content)) return true;

    if (!unwired && !wiredToConfigured) return false; // other agent groups: no group gate, no auto-wire

    // Nothing more to enforce or do for an unwired channel when auto-wire is off.
    if (unwired && !cfg.auto_wire) return false;

    // 2. User-group gate (and the precondition of auto-wire).
    if (!cfg.user_group_id) {
      if (!unwired) return false; // no group configured: nothing to gate on a wired channel
      await drop(event, cfg, found?.mg, userId, 'slack_team_access_misconfigured', content);
      return true;
    }
    let member = false;
    let failed = false;
    if (sender) {
      try {
        member = await isGroupMember(cfg, sender);
      } catch (err) {
        failed = true;
        log.warn('Slack team access: user group lookup failed, denying', { err });
      }
    }
    if (!member) {
      await drop(
        event,
        cfg,
        found?.mg,
        userId,
        failed ? 'slack_group_lookup_failed' : sender ? 'slack_not_in_user_group' : 'slack_unknown_sender',
        content,
      );
      if (addressed && !failed) await notify('refusal', cfg, event, channel, sender);
      return true;
    }

    // 3. Auto-wire, then let the router carry on.
    let mg = found?.mg;
    if (unwired) mg = await autoWire(event, cfg, found);
    // Admitted. For a channel this module auto-wired, the registered access grant (below) lets the
    // permissions gates admit this one message; hand-wired channels keep the owner's own policy.
    return false;
  }

  /**
   * Access grant: admits one message on one wiring when the instance has a row, the wiring is the exact one
   * this module auto-wired for the configured agent group, and the sender is in the user group. Anything
   * else (including a failed lookup) is no grant.
   */
  async function grant(
    event: InboundEvent,
    _userId: string | null,
    mg: MessagingGroup,
    agent: MessagingGroupAgent,
  ): Promise<boolean> {
    if (event.channelType !== 'slack') return false;
    const cfg = await getConfig(mg.instance ?? mg.channel_type);
    if (!cfg || !cfg.user_group_id || agent.agent_group_id !== cfg.agent_group_id) return false;
    if (!(await isAutoWired(mg.id, cfg.agent_group_id, agent.id))) return false;
    const sender = rawSender(parseContent(event.message.content))?.split(':').pop();
    if (!sender) return false;
    try {
      return await isGroupMember(cfg, sender);
    } catch (err) {
      log.warn('Slack team access: user group lookup failed, no grant', { err });
      return false;
    }
  }

  /**
   * Prepended response handler for ask_user_question cards (which have no access rule of their own).
   * It claims only a click that has a pending-question row and sits in a gated session, and refuses it
   * unless the clicker is in the user group. Approval cards have no pending-question row, so they are
   * never seen or blocked here.
   */
  async function responseHandler(payload: ResponsePayload): Promise<ResponseOutcome | false> {
    if (payload.channelType !== 'slack') return false;
    if (!(await hasTable(getDb(), 'pending_questions'))) return false;
    const pq = await getPendingQuestion(payload.questionId);
    if (!pq) return false;
    try {
      const session = await getSession(pq.session_id);
      const cfg = await getConfig(payload.instance ?? payload.channelType);
      if (!session || !cfg || !cfg.user_group_id || session.agent_group_id !== cfg.agent_group_id) return false;
      const clicker = payload.userId?.split(':').pop();
      if (clicker && (await isGroupMember(cfg, clicker))) return false;
      log.info('Slack team access: card answer refused, not in the user group', { questionId: payload.questionId });
      return 'refused';
    } catch (err) {
      log.warn('Slack team access: could not check a card answer, refusing', { err });
      return 'refused';
    }
  }

  const intercept = async (event: InboundEvent): Promise<boolean> => {
    if (event.channelType !== 'slack') return false;
    try {
      return await decide(event, event.instance ?? event.channelType);
    } catch (err) {
      log.error('Slack team access failed, message dropped', { platformId: event.platformId, err });
      return true;
    }
  };

  return { intercept, grant, responseHandler };
}
