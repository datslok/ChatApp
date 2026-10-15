// $maths$ in a message, drawn by the very same KaTeX as the web page (the server's
// /katex-0.18.9/, with its settings: trust off, maxSize 20, mistakes in red instead of errors).
//
// React Native has no web page to draw HTML in, so each formula gets a tiny one of its own: a
// WebView (react-native-webview) showing a page that loads KaTeX from our server and draws just
// this formula. When it's drawn, the page measures it and sends its size back (postMessage), and
// the WebView is made exactly that big. The TeX goes into the page as a JavaScript string
// (JSON.stringify), never as HTML, and KaTeX reads it as TeX, so whatever someone types stays maths.
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { colors } from './colors';
import { SERVER } from './config';

function page(tex, display) {
  // "<" written as <, so a "</script>" in the TeX can't end the script early.
  const texString = JSON.stringify(tex).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/katex-0.18.9/katex.min.css">
<style>
  html, body { margin: 0; padding: 0; background: transparent; color: ${colors.text}; font-size: 16px; }
  #math { display: ${display ? 'block' : 'inline-block'}; white-space: nowrap; }
  .katex-display { margin: 4px 0; padding: 2px 0; overflow-x: auto; }
</style>
</head><body>
<span id="math"></span>
<script src="/katex-0.18.9/katex.min.js"></script>
<script>
  const element = document.getElementById("math");
  const tex = ${texString};
  if (typeof katex === "undefined") {
    element.textContent = ${display ? '"$$" + tex + "$$"' : '"$" + tex + "$"'};  // (KaTeX didn't load: as typed)
  } else {
    katex.render(tex, element, { displayMode: ${display}, throwOnError: false, maxSize: 20 });
  }
  // Tell the app how big it is, once the fonts are in (they change the size).
  function report() {
    const box = element.getBoundingClientRect();
    window.ReactNativeWebView.postMessage(JSON.stringify({ width: Math.ceil(box.width) + 1, height: Math.ceil(box.height) }));
  }
  document.fonts.ready.then(report);
</script>
</body></html>`;
}

export default function MathView({ tex, display }) {
  const [size, setSize] = useState(null);  // {width, height} once the page has said
  const box = display
    ? { width: '100%', height: size?.height ?? 24 }
    // (Until it has said how big it is: room for it to be measured properly. Squeezed into
    // 1 px at the start, the page measured its formula wrong and it never showed.)
    : { width: size?.width ?? 200, height: size?.height ?? 22 };

  return (
    <WebView
      source={{ html: page(tex, display), baseUrl: SERVER }}  // (baseUrl: so "/katex-0.18.9/..." means our server)
      originWhitelist={['*']}
      onMessage={(event) => setSize(JSON.parse(event.nativeEvent.data))}
      // Nothing in it is a link, and nothing may take it anywhere else.
      // (Only the first load of our own page, which Android reports as the base address, about: or data:.)
      onShouldStartLoadWithRequest={(request) => [SERVER, SERVER + '/'].includes(request.url)
        || request.url.startsWith('about:') || request.url.startsWith('data:')}
      setSupportMultipleWindows={false}
      scrollEnabled={display}  // a wide display formula scrolls sideways, like the web page's
      style={[styles.math, box]}
      // The box react-native-webview puts around it has flex: 1 ("grow into the free space"): in a
      // row of words that starts from zero width, and the formula vanished. So it gets the size too.
      containerStyle={[styles.container, box]}
    />
  );
}

const styles = StyleSheet.create({
  math: { backgroundColor: 'transparent' },
  container: { flex: 0 },
});
