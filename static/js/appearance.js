// Appearance (Settings → Appearance): theme, colours, font and text size.
//
// Loaded in <head>, unlike the other scripts: it runs before the browser draws anything, so the
// page appears in your theme straight away, from the copy kept in this browser. The server keeps
// the real one with your account, sends it in "welcome" (core.js) and to all your open pages
// after a change ("appearance"), and checks every value (server.py, change_appearance).
//
// Everything works through chat.css's variables: data-theme on <html> picks a theme's colours,
// colours picked by hand are set on <html> itself (which beats the theme), and so are the font
// (--font) and the text size (everything in rem follows <html>'s font size).

// The fonts to choose from: Windows' own, each with a similar one for other systems after it.
// (The names must be the same as APPEARANCE_FONTS in server.py.)
const APPEARANCE_FONTS = {
  system: "system-ui, sans-serif",
  calibri: "Calibri, Carlito, sans-serif",
  georgia: "Georgia, serif",
  consolas: "Consolas, Menlo, monospace",
  comic: "'Comic Sans MS', 'Comic Neue', cursive",
};

const DEFAULT_APPEARANCE = { theme: "dark", colours: {}, font: "system", font_size: 16 };
let appearance = DEFAULT_APPEARANCE;

// Show these settings (missing ones: the defaults), and keep them in this browser for next time.
function applyAppearance(settings) {
  appearance = { ...DEFAULT_APPEARANCE, ...settings };  // (...: copy the fields; later ones win)
  const root = document.documentElement;  // <html>
  root.dataset.theme = appearance.theme;  // <html data-theme="light">
  // Colours picked earlier but not now: back to the theme's. ([...]: a copy, since we remove.)
  for (const name of [...root.style]) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
  for (const [name, colour] of Object.entries(appearance.colours)) {
    root.style.setProperty("--" + name, colour);
  }
  root.style.setProperty("--font", APPEARANCE_FONTS[appearance.font] || APPEARANCE_FONTS.system);
  root.style.fontSize = appearance.font_size + "px";
  try {
    localStorage.setItem("appearance", JSON.stringify(appearance));
  } catch {}
}

// Change them (Settings → Appearance): show them here at once, then save them with the account.
// Resolves to true once saved; the server then sends them to our other open pages too.
async function saveAppearance(settings) {
  applyAppearance(settings);
  try {
    const response = await fetch("/settings/appearance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appearance),
    });
    return response.ok;
  } catch {
    return false;  // no connection
  }
}

// Straight away: the copy from last time (or the defaults).
try {
  applyAppearance(JSON.parse(localStorage.getItem("appearance")) || {});
} catch {
  applyAppearance({});
}
