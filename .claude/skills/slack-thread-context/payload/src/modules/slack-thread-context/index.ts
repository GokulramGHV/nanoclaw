/**
 * slack-thread-context module: when an agent is tagged partway through a Slack
 * thread, it is shown the thread's earlier messages and files, who asked, and
 * the thread's link. Importing this file creates the settings table and
 * registers the wake-context provider. Off for every agent group until enabled.
 */
import './db/migrations.js';
import './wake.js';
