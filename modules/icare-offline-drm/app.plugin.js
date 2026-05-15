/* eslint-disable @typescript-eslint/no-var-requires */
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

/**
 * Expo config plugin that registers the OfflineDownloadService in the
 * AndroidManifest. Also ensures FOREGROUND_SERVICE permissions are present
 * (we declare them in app.json as well; this keeps the module self-contained
 * if it's later extracted).
 */
function withIcareOfflineDrm(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;

    const permissions = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    ];
    manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
    for (const perm of permissions) {
      const exists = manifest.manifest['uses-permission'].some(
        (p) => p.$ && p.$['android:name'] === perm
      );
      if (!exists) {
        manifest.manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    }

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    application.service = application.service || [];

    const serviceName = 'expo.modules.icareofflinedrm.OfflineDownloadService';
    const exists = application.service.some(
      (s) => s.$ && s.$['android:name'] === serviceName
    );

    if (!exists) {
      application.service.push({
        $: {
          'android:name': serviceName,
          'android:exported': 'false',
          'android:foregroundServiceType': 'dataSync',
        },
      });
    }

    return cfg;
  });
}

module.exports = withIcareOfflineDrm;
