/**
 * Switch off OpenUI's telemetry. This file must be imported before anything
 * that imports slack-ui-kit, so the variable is set before OpenUI reads it.
 */
process.env.OPENUI_TELEMETRY_DISABLED ??= '1';
