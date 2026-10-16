/* eslint-disable @typescript-eslint/no-var-requires */
const { withInfoPlist } = require('expo/config-plugins');

/**
 * iOS only: allow landscape in Info.plist so the offline video player can rotate for
 * full screen. The app itself stays portrait everywhere else: the module's
 * IcareOrientationSubscriber returns portrait unless the player asks for landscape.
 * Android and web are not touched.
 */
module.exports = function withIosLandscapeOrientations(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UISupportedInterfaceOrientations = [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ];
    return cfg;
  });
};
