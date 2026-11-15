// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices of the last reads (never a read sooner than the interval).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands: turning off and closing are never held.
  gladys.onSetValue(async (device, feature, value) => {
    const outcome = await app.setValue(device, feature, value);
    logger?.info(`Command to ${feature?.external_id}: ${outcome}`);
  });

  // Configuration screen buttons (a verification code is asked on this click only).
  gladys.onAction(ACTIONS.SEND_CODE, () => app.sendCode());
  gladys.onAction(ACTIONS.AUTHORIZE, (fields) => app.authorize(fields));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration saved by the user (or the tokens saved by the module).
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.configUpdated(config);
  });

  // Connection lifecycle: status and Discovery sent again on every connection
  // (the core keeps them in memory only); the configuration read until it comes.
  gladys.on('connected', () =>
    app.connected().catch((err) => logger?.error(`Start failed: ${err.message}`)),
  );
}
