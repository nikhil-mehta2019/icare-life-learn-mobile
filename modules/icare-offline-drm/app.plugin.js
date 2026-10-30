/**
 * Expo config plugin for icare-offline-drm.
 *
 * The android/ directory is pre-configured — OfflineDownloadService and
 * OfflinePlayerActivity are already registered in AndroidManifest.xml, and
 * eas.json uses prebuildCommand: "echo 'skipping prebuild'" so expo prebuild
 * never runs.
 *
 * This file exists only to satisfy the app.json plugin reference so that
 * `expo config` resolves without error during EAS build setup.
 */
const { createRunOncePlugin } = require('@expo/config-plugins');

const withIcareOfflineDrm = (config) => config;

module.exports = createRunOncePlugin(withIcareOfflineDrm, 'icare-offline-drm', '0.1.0');
