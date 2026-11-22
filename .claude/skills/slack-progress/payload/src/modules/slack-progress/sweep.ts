/**
 * Sweep for plans and streams left open when a container died. Anything silent
 * for 120000 ms whose session has no running container is closed: the plan is
 * redrawn as stopped, and the stream is ended with a short note. Groups where
 * the feature is off get no Slack calls. The sweep never throws.
 */
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { isContainerRunning } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { envValue } from '../../env.js';
import { log } from '../../log.js';
import { closePlan, listStale, upsertStream, type PlanRow, type StreamRow } from './db/progress.js';
import { renderSummary, type ProgressRow } from './render.js';
import { isEnabled } from './settings.js';
import { endWithNote } from './streams.js';

export const STALE_MS = 120000;
export const SWEEP_INTERVAL_MS = 30000;
const NOTE_INTERRUPTED = '_Reply interrupted._';

async function sweepPlan(plan: PlanRow): Promise<void> {
  if (isContainerRunning(plan.sessionId)) return;
  if (await isEnabled(plan.agentGroupId)) {
    const token = envValue(botTokenKeyForInstance(plan.instance));
    if (token && plan.messageTs) {
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
        // A pending card may have been refused; retry once without it.
        await draw(false);
      }
    }
  }
  await closePlan(plan.turnId);
}

async function sweepStream(stream: StreamRow): Promise<void> {
  if (isContainerRunning(stream.sessionId)) return;
  const session = await getSession(stream.sessionId);
  if (session && (await isEnabled(session.agent_group_id))) {
    await endWithNote(stream, NOTE_INTERRUPTED);
  }
  await upsertStream({ ...stream, status: 'stopped', updatedAt: new Date().toISOString() });
}

export async function sweepOnce(now: number): Promise<void> {
  try {
    const { plans, streams } = await listStale(new Date(now - STALE_MS).toISOString());
    for (const plan of plans) {
      await sweepPlan(plan).catch((err) => {
        log.warn('slack-progress: sweep of plan failed', { turnId: plan.turnId, err: String(err) });
      });
    }
    for (const stream of streams) {
      await sweepStream(stream).catch((err) => {
        log.warn('slack-progress: sweep of stream failed', { streamId: stream.streamId, err: String(err) });
      });
    }
  } catch (err) {
    log.warn('slack-progress: sweep failed', { err: String(err) });
  }
}
