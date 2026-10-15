// An Expo config plugin (see animated-webp.js): release builds signed with our own key.
//
// Android only installs an update over an app signed with the same key, so every release APK must be
// signed with one key, kept for good: losing it means everyone uninstalling and installing again.
// Expo's generated android/app/build.gradle signs release builds with the debug key that every project
// shares, so this adds a "release" signing config read from four Gradle properties, which live outside
// the repo, in ~/.gradle/gradle.properties (Gradle reads that file by itself):
//
//   CHATAPP_RELEASE_STORE_FILE=C:/Users/you/.chatapp-keys/android-release.jks
//   CHATAPP_RELEASE_STORE_PASSWORD=...
//   CHATAPP_RELEASE_KEY_ALIAS=chatapp
//   CHATAPP_RELEASE_KEY_PASSWORD=...
//
// (README, "The native app": making the key.) Without them, release builds keep the debug key.
const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING_CONFIG = `
        release {
            if (findProperty('CHATAPP_RELEASE_STORE_FILE')) {
                storeFile file(findProperty('CHATAPP_RELEASE_STORE_FILE'))
                storePassword findProperty('CHATAPP_RELEASE_STORE_PASSWORD')
                keyAlias findProperty('CHATAPP_RELEASE_KEY_ALIAS')
                keyPassword findProperty('CHATAPP_RELEASE_KEY_PASSWORD')
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents;
    if (gradle.includes('CHATAPP_RELEASE_STORE_FILE')) return config;  // (already done)
    // The signing config, after the debug one inside signingConfigs { }.
    const signingConfigs = gradle.indexOf('signingConfigs {');
    const debugBlockEnd = signingConfigs === -1 ? -1 : gradle.indexOf('}', gradle.indexOf('debug {', signingConfigs));
    if (debugBlockEnd === -1) throw new Error('release-signing: no signingConfigs in build.gradle');
    gradle = gradle.slice(0, debugBlockEnd + 1) + SIGNING_CONFIG + gradle.slice(debugBlockEnd + 1);
    // The release build type: our key if it's set up, else the debug one as before.
    const releaseType = gradle.indexOf('release {', gradle.indexOf('buildTypes {'));
    const line = gradle.indexOf('signingConfig signingConfigs.debug', releaseType);
    if (releaseType === -1 || line === -1) throw new Error('release-signing: no release build type in build.gradle');
    gradle = gradle.slice(0, line)
      + "signingConfig findProperty('CHATAPP_RELEASE_STORE_FILE') ? signingConfigs.release : signingConfigs.debug"
      + gradle.slice(line + 'signingConfig signingConfigs.debug'.length);
    config.modResults.contents = gradle;
    return config;
  });
};
