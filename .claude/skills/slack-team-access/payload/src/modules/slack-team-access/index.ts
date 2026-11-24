/**
 * slack-team-access module: lets a team bot's Slack instance auto-wire any
 * channel or DM it is invited to, admits only members of one Slack user group,
 * and refuses in Slack Connect channels. Importing this file creates the
 * config tables and registers the pre-route interceptor. Off for every
 * instance until an operator saves a config row for it.
 */
import './db/migrations.js';
import { registerMessageInterceptor } from '../../router.js';
import { createTeamAccess } from './gate.js';

registerMessageInterceptor(createTeamAccess());
