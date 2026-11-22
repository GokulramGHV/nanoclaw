/**
 * slack-progress module: a live plan message and streamed replies in Slack.
 * Importing this file runs the migration, registers the `progress`,
 * `stream_append` and `stream_abort` delivery actions and the reply
 * interceptor, and starts the sweep for plans and streams left open.
 */
import './db/migrations.js';
import './plan.js';
import './streams.js';
import { SWEEP_INTERVAL_MS, sweepOnce } from './sweep.js';

setInterval(() => void sweepOnce(Date.now()), SWEEP_INTERVAL_MS).unref();
