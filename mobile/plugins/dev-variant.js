// An Expo config plugin (see animated-webp.js): development builds as an app of their own, "ChatApp Dev"
// (no.datslok.chat.dev), next to the real ChatApp on the same phone.
//
// Android tells apps apart by their package name, and only installs an app over one with the same name
// if both are signed with the same key. Development builds are signed with the debug key, releases with
// ours (release-signing.js), so under one name they'd push each other off the phone. Different names,
// and both stay: chatting with friends in the real app while developing in the other.
//   - android/app/build.gradle: the debug build type adds ".dev" to the package name.
//   - android/app/src/debug/res/values/strings.xml: its name on the phone; the debug build's own
//     resources win over the main ones.
// Firebase knows both names (google-services.json has an Android app for each).
const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const NAME = 'ChatApp Dev';

module.exports = function withDevVariant(config) {
  config = withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents;
    if (gradle.includes('applicationIdSuffix ".dev"')) return config;
    const debugType = gradle.indexOf('debug {', gradle.indexOf('buildTypes {'));
    if (debugType === -1) throw new Error('dev-variant: no debug build type in build.gradle');
    const inside = debugType + 'debug {'.length;
    gradle = gradle.slice(0, inside) + '\n            applicationIdSuffix ".dev"' + gradle.slice(inside);
    config.modResults.contents = gradle;
    return config;
  });
  // "Dangerous": writes a file straight into android/ (there's no ready-made mod for the debug resources).
  return withDangerousMod(config, ['android', (config) => {
    const folder = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'debug', 'res', 'values');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'strings.xml'),
      `<resources>\n  <string name="app_name">${NAME}</string>\n</resources>\n`);
    return config;
  }]);
};
