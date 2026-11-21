/**
 * slack-ui module: interactive Slack cards from JSON templates.
 * Importing this file runs the migrations, the click handler registration
 * and the `post_card` delivery action registration.
 */
import './db/migrations.js';
import './clicks.js';
import './post-card.js';
