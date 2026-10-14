// Line icons on the buttons instead of emoji: calmer, in the text's colour (so in every theme), and
// the same on every device. The shapes are Lucide's, in icon-shapes.js (made by tools/make_icons.py).
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.
//
// In index.html: data-icon="mic" on an element puts that icon at its start (below, at load).
// In the scripts: makeIcon("pin") makes one, setIcon(button, "mic-off") swaps a button's icon.

// A new <svg class="icon"> with one of the shapes; chat.css (.icon) draws its lines in the text's colour.
// (innerHTML is fine here: the shapes are our own fixed text from icon-shapes.js, never anything people wrote.)
function makeIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");  // (SVG has its own "namespace")
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");  // screen readers read the button's title or text instead
  svg.innerHTML = ICON_SHAPES[name] ?? "";
  return svg;
}

// Put an icon at the start of an element, instead of the one it had: a button that's only an icon,
// or one with words after it ("[icon] Join call", which gets "has-label" for the space in between).
function setIcon(element, name) {
  element.querySelector(":scope > svg.icon")?.remove();  // (:scope > : only its own, not deeper ones)
  element.prepend(makeIcon(name));
  element.classList.toggle("has-label", element.textContent.trim() !== "");
}

for (const element of document.querySelectorAll("[data-icon]")) setIcon(element, element.dataset.icon);
