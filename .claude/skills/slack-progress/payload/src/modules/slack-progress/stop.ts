/**
 * Close a plan as stopped: redraw it as "Stopped after ..." (best effort), clear its
 * status line, and mark it closed. Used by the sweep for plans left open by a dead
 * container, and by the plan handler when a new turn starts in the same session.
 */
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { closePlan, type PlanRow } from './db/progress.js';
import { withRateLimitRetry } from './rate-limit.js';
import { renderPlainSummary, renderSummary, type ProgressRow } from './render.js';
import { clearWorkingStatus } from './status.js';

/**
 * Redraw the plan as stopped. Throws on a Slack failure; the caller logs it. This runs
 * even when the group has been switched off since, so a plan is never left drawn as
 * working. Each Slack call waits out a rate limit.
 */
async function redrawStopped(plan: PlanRow): Promise<void> {
  const token = envValue(botTokenKeyForInstance(plan.instance));
  if (!token || !plan.messageTs) return;
  const state = JSON.parse(plan.stateJson) as ProgressRow;
  const spent = Date.parse(plan.updatedAt) - Date.parse(state.startedAt);
  const row: ProgressRow = {
    ...state,
    outcome: 'error',
    elapsedMs: Number.isFinite(spent) && spent > 0 ? spent : state.elapsedMs,
  };
  const base = { channel: plan.channelId, ts: plan.messageTs };
  const update = (r: { text: string; blocks: unknown[] }) =>
    withRateLimitRetry(() => slackCall(token, 'chat.update', { ...base, text: r.text, blocks: r.blocks }, 'progress'));
  try {
    await update(renderSummary(row));
  } catch {
    // Slack may have refused the plan block; fall back to plain text.
    await update(renderPlainSummary(row));
  }
}

/** Never throws. The plan is closed even when the redraw fails, so nothing retries it forever. */
export async function stopPlan(plan: PlanRow): Promise<void> {
  try {
    await redrawStopped(plan);
  } catch (err) {
    log.warn('slack-progress: could not redraw stopped plan', { turnId: plan.turnId, err: String(err) });
  }
  try {
    clearWorkingStatus(plan.sessionId, plan.turnId);
    await closePlan(plan.turnId);
  } catch (err) {
    log.warn('slack-progress: could not close stopped plan', { turnId: plan.turnId, err: String(err) });
  }
}
