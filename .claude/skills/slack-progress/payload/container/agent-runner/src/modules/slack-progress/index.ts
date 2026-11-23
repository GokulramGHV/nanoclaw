/**
 * Slack progress module wiring. One tracker and one streamer, both gated by a
 * marker file the host writes when the feature is on for this agent group.
 */
import fs from 'fs';
import { findByName } from '../../destinations.js';
import { writeMessageOut } from '../../db/messages-out.js';
import {
  registerChatRowDecorator,
  registerChatRowHold,
  registerHoldBarrier,
  registerProgressObserver,
} from '../../progress-seam.js';
import { createHold, flushHoldOnCardTool } from './hold.js';
import { createStreamer, MARKER_PATH } from './streamer.js';
import { createProgressTracker } from './tracker.js';

function newId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function enabled(): boolean {
  return fs.existsSync(MARKER_PATH);
}

function setTimer(fn: () => void, ms: number): () => void {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
}

function send(row: object): void {
  void writeMessageOut({ id: newId(), kind: 'system', content: JSON.stringify(row) }).catch((err) => {
    console.error(`[slack-progress] write failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

const tracker = createProgressTracker({ now: () => Date.now(), setTimer, send, enabled, newId });
const streamer = createStreamer({
  now: () => Date.now(),
  setTimer,
  send,
  enabled,
  newId,
  resolve: (to) => {
    const dest = findByName(to);
    if (!dest || dest.type !== 'channel' || !dest.platformId || !dest.channelType) return null;
    return { platformId: dest.platformId, channelType: dest.channelType };
  },
  held: (platformId) => tracker.stepsOpen(platformId),
});
const hold = createHold({
  stepsOpen: (platformId) => tracker.stepsOpen(platformId),
  log: (msg) => console.error(`[slack-progress] ${msg}`),
  // A block that streamed before the task list existed is now held: end its stream at once.
  onHeld: (row) => streamer.dropFinished(row.platformId, row.body),
});

registerProgressObserver((e) => {
  tracker.onEvent(e);
  streamer.onEvent(e);
  hold.onEvent(e);
});
registerProgressObserver(flushHoldOnCardTool(hold, () => tracker.currentPlatformId()));
registerChatRowHold((row, write) => hold.offer(row, write));
registerChatRowDecorator((row) => streamer.decorate(row));
registerHoldBarrier((platformId) => hold.barrier(platformId));
