/**
 * slack-progress module: a live plan message and streamed replies in Slack.
 * Importing this file runs the migration, registers the `progress`,
 * `stream_append` and `stream_abort` delivery actions, the reply
 * interceptors and the wake-context provider, and starts the sweep for plans and streams left open.
 */
import './db/migrations.js';
// Before the reply interceptor, so it sees every reply.
import './wake-status.js';
import './plan.js';
import './streams.js';
import './wake.js';
import { SWEEP_INTERVAL_MS, sweepOnce } from './sweep.js';

setInterval(() => void sweepOnce(Date.now()), SWEEP_INTERVAL_MS).unref();
