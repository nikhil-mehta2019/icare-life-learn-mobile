/* eslint-disable @typescript-eslint/no-var-requires */
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * iOS-only build fixes, re-applied on every `expo prebuild` so the generated
 * (gitignored) ios/ folder always builds. Registers iOS modifiers only: it does
 * nothing for Android or web.
 *
 *  1. Xcode 26 clang rejects the consteval usage in the `fmt` pod -> build that
 *     pod as C++17.
 *  2. Project paths containing spaces break the expo-constants script phase
 *     -> quote the script path.
 *  3. Same problem in the "Bundle React Native code and images" build phase.
 */

const PODFILE_MARKER = '# [withIosBuildFixes]';

const PODFILE_SNIPPET = String.raw`
    ${PODFILE_MARKER} Xcode 26 clang rejects fmt's consteval usage; build the fmt pod as C++17.
    installer.pods_project.targets.each do |target|
      next unless target.name == 'fmt'
      target.build_configurations.each do |build_config|
        build_config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
      end
    end

    ${PODFILE_MARKER} Project path may contain spaces: quote script paths in Pods shell-script phases.
    installer.pods_project.targets.each do |target|
      target.build_phases.each do |phase|
        next unless phase.respond_to?(:shell_script) && phase.shell_script
        phase.shell_script = phase.shell_script.gsub(
          'bash -l -c "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"'
        ) { 'bash -l -c "\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\""' }
      end
    end
`;

function withPodfileFixes(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) {
        console.warn('[withIosBuildFixes] Podfile not found; skipping Podfile fixes.');
        return cfg;
      }
      const contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(PODFILE_MARKER)) {
        return cfg; // already applied
      }
      // Insert right after the react_native_post_install(...) call.
      const callRe = /react_native_post_install\([\s\S]*?\n[ \t]*\)\n/;
      const match = contents.match(callRe);
      if (!match) {
        console.warn(
          '[withIosBuildFixes] react_native_post_install call not found in Podfile; skipping Podfile fixes.'
        );
        return cfg;
      }
      const at = match.index + match[0].length;
      fs.writeFileSync(
        podfilePath,
        contents.slice(0, at) + PODFILE_SNIPPET + contents.slice(at)
      );
      return cfg;
    },
  ]);
}

function withBundlePhaseFix(config) {
  return withXcodeProject(config, (cfg) => {
    const phases = cfg.modResults.hash.project.objects.PBXShellScriptBuildPhase || {};
    // The last line runs `<node> --print "..."` unquoted in backticks, which
    // splits on spaces. Wrap it as "$(...)" instead.
    const re = /`(\\"\$NODE_BINARY\\" --print [^`]*)`/;
    for (const key of Object.keys(phases)) {
      if (key.endsWith('_comment')) continue;
      const phase = phases[key];
      if (
        typeof phase.name === 'string' &&
        phase.name.includes('Bundle React Native code and images') &&
        typeof phase.shellScript === 'string' &&
        re.test(phase.shellScript)
      ) {
        phase.shellScript = phase.shellScript.replace(re, '\\"$($1)\\"');
      }
    }
    return cfg;
  });
}

module.exports = function withIosBuildFixes(config) {
  config = withPodfileFixes(config);
  config = withBundlePhaseFix(config);
  return config;
};
