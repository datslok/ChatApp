---
paths:
  - "static/**"
---

# The web page

How it's built: `docs/notes/web-page.md`. Checking a page in headless Edge: `check-page` skill.

- **Never insert user text with `innerHTML`:** build elements and set `textContent`. The only `innerHTML` is in
  `icons.js`, for our own fixed SVG shapes (a hook blocks any other).
- **Load order:** code that runs at load time may only use what earlier files declare (the order is in index.html).
- **Colours:** every colour in chat.css is a variable in its `:root`, named by role (themes change them).
- **Buttons use line icons, not emoji.** Emoji stay in OS notifications, server notes, What's new and anything
  people write.
- **Limits come from the server's `LIMITS`** (in "welcome"), never a copied number.
- **A picture loads at the size it's shown;** only the viewer loads the original.
- **Choosing from what could be everyone (or many):** a type-to-search picker (the shared one in messages.js and
  people.js), never a `<select>` drop-down or a long unfiltered list. A list of checkboxes gets a search box on top.
- **The phone layout** (chat.css `@media (max-width: 700px)`) is what the native phone app copies: a change there is
  a change for `mobile/` too.
