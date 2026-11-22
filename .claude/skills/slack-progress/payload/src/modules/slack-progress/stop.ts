/**
 * Close a plan as stopped: redraw it as "Stopped after ..." (best effort), clear its
 * status line, and mark it closed. Used by the sweep for plans left open by a dead
 * container, and by the plan handler when a new turn starts in the same session.
 */
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { closePlan, type PlanRow } from './db/progress.js';
import { renderPlainSummary, renderSummary, type ProgressRow } from './render.js';
import { isEnabled } from './settings.js';
import { clearWorkingStatus } from './status.js';

/** Redraw the plan as stopped. Throws on a Slack failure; the caller logs it. */
async function redrawStopped(plan: PlanRow): Promise<void> {
  if (!(await isEnabled(plan.agentGroupId))) return;
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
  const draw = (pendingOk: boolean) => {
    const r = renderSummary(row, { pendingOk });
    return slackCall(token, 'chat.update', { ...base, text: r.text, blocks: r.blocks }, 'progress');
  };
  try {
    await draw(true);
  } catch {
    // A pending card may have been refused; retry once without it, then fall back to plain text.
    try {
      await draw(false);
    } catch {
      const r = renderPlainSummary(row);
      await slackCall(token, 'chat.update', { ...base, text: r.text, blocks: r.blocks }, 'progress');
    }
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
