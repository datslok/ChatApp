// The line icons on the chat's buttons: Lucide's (lucide.dev), version 1.48.0, copied from npm's
// lucide-static by tools/make_icons.py (don't edit by hand: add a name there and run it again).
//
// Lucide's licence:
// ISC License
//
// Copyright (c) 2026 Lucide Icons and Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// ---
//
// The following Lucide icons are derived from the Feather project:
//
// airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
//
// The MIT License (MIT) (for the icons listed above)
//
// Copyright (c) 2013-present Cole Bemis
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export const ICON_SHAPES = {
  "arrow-down": "<path d=\"M12 5v14\" /> <path d=\"m19 12-7 7-7-7\" />",
  "arrow-up": "<path d=\"m5 12 7-7 7 7\" /> <path d=\"M12 19V5\" />",
  "ban": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M4.929 4.929 19.07 19.071\" />",
  "bell": "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /> <path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\" />",
  "bell-off": "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /> <path d=\"M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742\" /> <path d=\"m2 2 20 20\" /> <path d=\"M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05\" />",
  "bug": "<path d=\"M12 20v-9\" /> <path d=\"M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z\" /> <path d=\"M14.12 3.88 16 2\" /> <path d=\"M21 21a4 4 0 0 0-3.81-4\" /> <path d=\"M21 5a4 4 0 0 1-3.55 3.97\" /> <path d=\"M22 13h-4\" /> <path d=\"M3 21a4 4 0 0 1 3.81-4\" /> <path d=\"M3 5a4 4 0 0 0 3.55 3.97\" /> <path d=\"M6 13H2\" /> <path d=\"m8 2 1.88 1.88\" /> <path d=\"M9 7.13V6a3 3 0 1 1 6 0v1.13\" />",
  "chevron-down": "<path d=\"m6 9 6 6 6-6\" />",
  "file": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\" />",
  "gamepad-2": "<line x1=\"6\" x2=\"10\" y1=\"11\" y2=\"11\" /> <line x1=\"8\" x2=\"8\" y1=\"9\" y2=\"13\" /> <line x1=\"15\" x2=\"15.01\" y1=\"12\" y2=\"12\" /> <line x1=\"18\" x2=\"18.01\" y1=\"10\" y2=\"10\" /> <path d=\"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z\" />",
  "headphone-off": "<path d=\"M21 14h-1.343\" /> <path d=\"M9.128 3.47A9 9 0 0 1 21 12v3.343\" /> <path d=\"m2 2 20 20\" /> <path d=\"M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3\" /> <path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364\" />",
  "headphones": "<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\" />",
  "image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\" /> <circle cx=\"9\" cy=\"9\" r=\"2\" /> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\" />",
  "lightbulb": "<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\" /> <path d=\"M9 18h6\" /> <path d=\"M10 22h4\" />",
  "log-out": "<path d=\"m16 17 5-5-5-5\" /> <path d=\"M21 12H9\" /> <path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\" />",
  "maximize": "<path d=\"M8 3H5a2 2 0 0 0-2 2v3\" /> <path d=\"M21 8V5a2 2 0 0 0-2-2h-3\" /> <path d=\"M3 16v3a2 2 0 0 0 2 2h3\" /> <path d=\"M16 21h3a2 2 0 0 0 2-2v-3\" />",
  "megaphone": "<path d=\"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z\" /> <path d=\"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14\" /> <path d=\"M8 6v8\" />",
  "menu": "<path d=\"M4 5h16\" /> <path d=\"M4 12h16\" /> <path d=\"M4 19h16\" />",
  "mic": "<path d=\"M12 19v3\" /> <path d=\"M19 10v2a7 7 0 0 1-14 0v-2\" /> <rect x=\"9\" y=\"2\" width=\"6\" height=\"13\" rx=\"3\" />",
  "mic-off": "<path d=\"M12 19v3\" /> <path d=\"M15 9.34V5a3 3 0 0 0-5.68-1.33\" /> <path d=\"M16.95 16.95A7 7 0 0 1 5 12v-2\" /> <path d=\"M18.89 13.23A7 7 0 0 0 19 12v-2\" /> <path d=\"m2 2 20 20\" /> <path d=\"M9 9v3a3 3 0 0 0 5.12 2.12\" />",
  "minimize": "<path d=\"M8 3v3a2 2 0 0 1-2 2H3\" /> <path d=\"M21 8h-3a2 2 0 0 1-2-2V3\" /> <path d=\"M3 16h3a2 2 0 0 1 2 2v3\" /> <path d=\"M16 21v-3a2 2 0 0 1 2-2h3\" />",
  "monitor": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" /> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" /> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />",
  "monitor-up": "<path d=\"m9 10 3-3 3 3\" /> <path d=\"M12 13V7\" /> <rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" /> <path d=\"M12 17v4\" /> <path d=\"M8 21h8\" />",
  "music": "<path d=\"M9 18V5l12-2v13\" /> <circle cx=\"6\" cy=\"18\" r=\"3\" /> <circle cx=\"18\" cy=\"16\" r=\"3\" />",
  "paperclip": "<path d=\"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551\" />",
  "pencil": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\" /> <path d=\"m15 5 4 4\" />",
  "phone": "<path d=\"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384\" />",
  "phone-off": "<path d=\"M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272\" /> <path d=\"M22 2 2 22\" /> <path d=\"M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473\" />",
  "pin": "<path d=\"M12 17v5\" /> <path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z\" />",
  "reply": "<path d=\"M20 18v-2a4 4 0 0 0-4-4H4\" /> <path d=\"m9 17-5-5 5-5\" />",
  "search": "<path d=\"m21 21-4.34-4.34\" /> <circle cx=\"11\" cy=\"11\" r=\"8\" />",
  "settings": "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />",
  "trash-2": "<path d=\"M10 11v6\" /> <path d=\"M14 11v6\" /> <path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\" /> <path d=\"M3 6h18\" /> <path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" />",
  "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /> <path d=\"M16 3.128a4 4 0 0 1 0 7.744\" /> <path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /> <circle cx=\"9\" cy=\"7\" r=\"4\" />",
  "video": "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\" /> <rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\" />",
  "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />",
  "volume-2": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\" /> <path d=\"M16 9a5 5 0 0 1 0 6\" /> <path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\" />",
};
