// An Expo config plugin (like animated-webp.js): puts ChatApp in Android's share sheet. It adds two
// "intent filters" to the main screen (MainActivity) in the generated AndroidManifest.xml, saying it
// accepts SEND (one file or a text) and SEND_MULTIPLE (several files) of any type ("*/*"). The XML:
//   <intent-filter>
//     <action android:name="android.intent.action.SEND" />
//     <category android:name="android.intent.category.DEFAULT" />
//     <data android:mimeType="*/*" />
//   </intent-filter>
// What the app does with a share is in modules/shared-files.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const ACTIONS = ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE'];

module.exports = function withShareIntent(config) {
  return withAndroidManifest(config, (config) => {
    // The manifest as a JavaScript object: each XML element is an object, its attributes under "$",
    // and the elements inside it as lists by name.
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    const filters = (activity['intent-filter'] ??= []);
    for (const action of ACTIONS) {
      const already = filters.some((filter) => filter.action?.some((a) => a.$['android:name'] === action));
      if (already) continue;
      filters.push({
        action: [{ $: { 'android:name': action } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': '*/*' } }],
      });
    }
    return config;
  });
};
