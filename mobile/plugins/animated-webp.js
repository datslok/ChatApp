// An Expo "config plugin": a few lines that `npx expo prebuild` runs while it generates the
// android/ folder (which is never edited by hand). This one switches on animated WebP pictures in
// React Native's own <Image>, by setting expo.webp.animated=true in android/gradle.properties.
//
// Why: GIFs from GIPHY arrive as animated WebP, and Expo leaves that off by default (it adds
// about 3.4 MB to the app). React Native's <Image> also sends the login cookie with its requests
// (our server only gives pictures to logged-in people); expo-image, tried first, didn't.
const { withGradleProperties } = require('expo/config-plugins');

module.exports = function withAnimatedWebp(config) {
  return withGradleProperties(config, (config) => {
    const properties = config.modResults;  // the file's lines: [{type: 'property', key, value}, ...]
    const existing = properties.find((item) => item.type === 'property' && item.key === 'expo.webp.animated');
    if (existing) existing.value = 'true';
    else properties.push({ type: 'property', key: 'expo.webp.animated', value: 'true' });
    return config;
  });
};
