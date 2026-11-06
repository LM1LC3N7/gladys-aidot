// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app (src/app.js). Shared by index.js and the
// end-to-end tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the lights of the AiDot account (the cloud list, the local discovery).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands: power and brightness (0 = off), colour, colour temperature.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Every connection to Gladys: /data, then the configuration (read again on failure, with a
  // status).
  gladys.on('connected', async () => {
    try {
      await app.onConnected(() => gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
