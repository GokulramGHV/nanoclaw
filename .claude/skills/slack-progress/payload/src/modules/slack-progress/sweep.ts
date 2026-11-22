/**
 * Sweep for plans and streams left open when a container died. Anything silent
 * for 120000 ms whose session has no running container is closed: the plan is
 * redrawn as stopped, and the stream is ended with a short note. Groups where
 * the feature is off get no Slack calls. The sweep never throws.
 */
import { isContainerRunning } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { listStale, upsertStream, type PlanRow, type StreamRow } from './db/progress.js';
import { isEnabled } from './settings.js';
import { stopPlan } from './stop.js';
import { endWithNote } from './streams.js';

export const STALE_MS = 120000;
export const SWEEP_INTERVAL_MS = 30000;
const NOTE_INTERRUPTED = '_Reply interrupted._';

async function sweepPlan(plan: PlanRow): Promise<void> {
  if (isContainerRunning(plan.sessionId)) return;
  await stopPlan(plan);
}

async function sweepStream(stream: StreamRow): Promise<void> {
  if (isContainerRunning(stream.sessionId)) return;
  try {
    const session = await getSession(stream.sessionId);
    if (session && (await isEnabled(session.agent_group_id))) {
      await endWithNote(stream, NOTE_INTERRUPTED);
    }
  } catch (err) {
    log.warn('slack-progress: could not end stale stream', { streamId: stream.streamId, err: String(err) });
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
