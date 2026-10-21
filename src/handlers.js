// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle --------------------------------------------
  gladys.onScanRequest(() => app.publishDiscovery());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // --- Commands: the VM buttons only (each refused unless allowed) ---------------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- Configuration screen button --------------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // --- Configuration saved by the user: refused credentials are tried again,
  // a new certificate is accepted, other values are read at once.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config, { force: true });
  });

  // --- Connection lifecycle: (re)start on every connection (status and
  // Discovery sent again), pause while Gladys is away. A refusal, a pause, a
  // changed certificate and the last attempt kept in /data survive both.
  gladys.on('connected', async () => {
    try {
      await app.start(await gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed: ${err?.message}`);
    }
  });
  gladys.on('disconnected', () => app.stop());
}
