// Appearance (Settings → Appearance): theme, colours, font, text size and (in the app) scale.
//
// Loaded in <head>, unlike the other scripts: it runs before the browser draws anything, so the
// page appears in your theme straight away, from the copy kept in this browser. The server keeps
// the real one with your account, sends it in "welcome" (core.js) and to all your open pages
// after a change ("appearance"), and checks every value (server.py, change_appearance).
//
// Everything works through chat.css's variables: data-theme on <html> picks a theme's colours,
// colours picked by hand are set on <html> itself (which beats the theme), and so are the font
// (--font) and the text size (everything in rem follows <html>'s font size). The scale is the
// desktop app's own zoom (main.rs, set_zoom); browsers have Ctrl + and Ctrl − for that.

// The fonts to choose from: Windows' own, each with a similar one for other systems after it.
// (The names must be the same as APPEARANCE_FONTS in server.py.)
const APPEARANCE_FONTS = {
  system: "system-ui, sans-serif",
  calibri: "Calibri, Carlito, sans-serif",
  georgia: "Georgia, serif",
  consolas: "Consolas, Menlo, monospace",
  comic: "'Comic Sans MS', 'Comic Neue', cursive",
};

const DEFAULT_APPEARANCE = { theme: "dark", colours: {}, font: "system", font_size: 16, scale: 100 };

// Tauri puts __TAURI_INTERNALS__ on the app's pages (before any of ours run); browsers don't have it.
const canZoom = "__TAURI_INTERNALS__" in window;
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
  guardIconColours(root);
  root.style.fontSize = appearance.font_size + "px";
  // The app: zoom to the scale (1.2 for 120%). An app from before 0.1.15 has no set_zoom, and
  // refuses: nothing to do, it updates itself soon.
  if (canZoom) {
    window.__TAURI_INTERNALS__.invoke("set_zoom", { scale: appearance.scale / 100 }).catch(() => {});
  }
  try {
    localStorage.setItem("appearance", JSON.stringify(appearance));
  } catch {}
}

// Icons are lines in a text colour (icons.js), so they're only as easy to see as that colour is against
// what's behind them. The themes are made for that, but colours picked by hand may not be (a grey
// text on a grey panel). So: measure, and if needed use another colour for the icons (--icon, and
// --icon-strong under the mouse), without changing the colours that were picked.
//
// "Contrast ratio" is how accessibility guidelines (WCAG) measure this: from 1 (the same colour) to 21
// (black on white), worked out from how bright each colour looks to the eye. Icons need 3 or more.
const ICON_CONTRAST = 3;
const ICON_BACKGROUNDS = ["bg-panel-alt", "bg-panel", "bg-main", "bg-input"];  // where icons sit

// How bright a colour looks (its "relative luminance", 0 for black to 1 for white). Screens store
// colours "gamma-encoded", so each channel is first turned back into real light, then weighted by how
// sensitive the eye is to it: very much to green, much less to blue.
function luminance([r, g, b]) {
  const light = (channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * light(r) + 0.7152 * light(g) + 0.0722 * light(b);
}

function contrastRatio(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function guardIconColours(root) {
  // A variable can hold anything ("#949ba4", or another var(...)): let the browser work out the real
  // colour, by giving it to an element and reading back its computed colour ("rgb(148, 155, 164)").
  const probe = document.createElement("span");
  root.appendChild(probe);
  const colourOf = (name) => {
    probe.style.color = `var(--${name})`;
    return getComputedStyle(probe).color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  };
  const backgrounds = ICON_BACKGROUNDS.map(colourOf);
  const worst = (colour) => Math.min(...backgrounds.map((background) => contrastRatio(colour, background)));
  // The first of these text colours that's clear on every background; none: white or black, whichever is clearer.
  const pick = (names) => {
    for (const name of names) {
      if (worst(colourOf(name)) >= ICON_CONTRAST) return `var(--${name})`;
    }
    return worst([255, 255, 255]) >= worst([0, 0, 0]) ? "#ffffff" : "#000000";
  };
  // (The CSS's own values first, so they don't count as "the colour" while we measure.)
  root.style.removeProperty("--icon");
  root.style.removeProperty("--icon-strong");
  const icon = pick(["text-muted", "text-soft", "text"]);
  const strong = pick(["text-strong", "text"]);
  probe.remove();
  if (icon !== "var(--text-muted)") root.style.setProperty("--icon", icon);
  if (strong !== "var(--text-strong)") root.style.setProperty("--icon-strong", strong);
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
