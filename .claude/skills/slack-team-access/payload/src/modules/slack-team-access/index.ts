/**
 * slack-team-access module: lets a team bot's Slack instance auto-wire any
 * channel or DM it is invited to, admits only members of one Slack user group,
 * and refuses in Slack Connect channels. Importing this file creates the
 * config tables and registers the pre-route interceptor, the access grant and
 * the question-card response handler. Off for every instance until an operator
 * saves a config row for it. It needs the router's registerAccessGrant hook and
 * refuses to start without it.
 */
import './db/migrations.js';
import * as router from '../../router.js';
import { registerResponseHandler } from '../../response-registry.js';
import { log } from '../../log.js';
import { createTeamAccess } from './gate.js';

if (typeof router.registerAccessGrant !== 'function') {
  const msg =
    'slack-team-access needs registerAccessGrant in src/router.ts (the "feat(router): registerAccessGrant" change); refusing to start';
  log.error(msg);
  throw new Error(msg);
}

const access = createTeamAccess();
router.registerMessageInterceptor(access.intercept);
router.registerAccessGrant(access.grant);
registerResponseHandler(access.responseHandler, { prepend: true });
