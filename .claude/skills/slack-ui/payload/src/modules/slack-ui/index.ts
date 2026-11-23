/**
 * slack-ui module: interactive Slack cards on slack-ui-kit, from OpenUI Lang
 * templates. Importing this file runs the migrations, the click and form
 * handler registrations and the `post_card` and `ask` delivery action registrations.
 */
import './telemetry.js';
import './db/migrations.js';
import './events.js';
import './clicks.js';
import './forms.js';
import './post-card.js';
import './ask.js';
