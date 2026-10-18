// The picture viewer: the popup a clicked picture or video opens in (#image-viewer). A picture can be
// zoomed (mouse wheel, a touchpad or touchscreen pinch, double-click) and dragged around while zoomed;
// ‹ › and the arrow keys go through the others of the same message (or of the chat info panel's Media
// tab). At the bottom: "2 / 5", the file's name (a download link) and, from the panel, "Jump to message".
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're plain
// scripts sharing one global scope: what one file declares, the others can use. The functions it
// calls from messages.js (makeFileLink, videoVolume, ...) only run once something is opened.

const viewer = document.getElementById("image-viewer");
const viewerImage = document.getElementById("viewer-image");
const viewerVideo = document.getElementById("viewer-video");
const viewerClose = document.getElementById("viewer-close");
const viewerPrev = document.getElementById("viewer-prev");
const viewerNext = document.getElementById("viewer-next");
const viewerCount = document.getElementById("viewer-count");
const viewerFile = document.getElementById("viewer-file");
const viewerJump = document.getElementById("viewer-jump");

let viewerItems = [];    // what can be looked at: [{file, message}], pictures and videos
let viewerIndex = 0;     // the one showing
let viewerOnJump = null; // what "Jump to message" does with an item; null: no such button

// Open the viewer. items: [{file, message}]; index: the one to show first; onJump: see viewerOnJump.
function openViewer(items, index = 0, onJump = null) {
  viewerItems = items;
  viewerOnJump = onJump;
  showViewerItem(index);
  viewer.showModal();  // open as a modal: on top of everything; Esc closes it
}

function showViewerItem(index) {
  viewerIndex = index;
  const { file, message } = viewerItems[index];  // (takes the object apart into two names)
  const url = "/uploads/" + encodeURIComponent(file.id);
  resetZoom();
  // A video plays in the browser's player instead of the picture (no zooming those).
  viewerVideo.pause();
  if (file.video) {
    viewerImage.hidden = true;
    viewerImage.removeAttribute("src");
    viewerVideo.hidden = false;
    viewerVideo.src = url;
    viewerVideo.dataset.fileId = file.id;
    viewerVideo.volume = videoVolume(file.id);  // (messages.js: each video remembers its volume)
    viewerVideo.play().catch(() => {});  // (a browser may refuse to start it by itself: then press play)
  } else {
    viewerVideo.hidden = true;
    viewerVideo.removeAttribute("src");
    viewerImage.hidden = false;
    // Drop the old picture first, so the next one doesn't briefly show the old one while loading.
    viewerImage.removeAttribute("src");
    viewerImage.src = url;
    viewerImage.alt = file.filename;
  }

  const several = viewerItems.length > 1;
  viewerPrev.hidden = viewerNext.hidden = viewerCount.hidden = !several;
  viewerCount.textContent = `${index + 1} / ${viewerItems.length}`;
  viewerFile.replaceChildren(makeFileLink(url, file, message));  // (messages.js; in the app: "Download this file?")
  viewerJump.hidden = viewerOnJump === null;
}

// ‹ and ›: one back or on, going round at the ends (% is the remainder, so 5 % 5 = 0 starts over).
function stepViewer(step) {
  if (viewerItems.length < 2) return;
  showViewerItem((viewerIndex + step + viewerItems.length) % viewerItems.length);
}
viewerPrev.addEventListener("click", () => stepViewer(-1));
viewerNext.addEventListener("click", () => stepViewer(1));
viewer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") stepViewer(-1);
  else if (event.key === "ArrowRight") stepViewer(1);
  else return;
  event.preventDefault();  // (or the video player would also skip 5 seconds)
});

viewerJump.addEventListener("click", () => {
  const item = viewerItems[viewerIndex];
  viewer.close();
  viewerOnJump(item);
});

// A click on the dark area around the picture has the dialog itself as the target (a click on the
// picture has the <img>). Only the dark area closes it, and not right after dragging the picture.
viewer.addEventListener("click", (event) => {
  if (event.target === viewer && !justDragged) viewer.close();
});
viewerClose.addEventListener("click", () => viewer.close());
viewerVideo.addEventListener("volumechange", () => saveVideoVolume(viewerVideo.dataset.fileId, viewerVideo.volume));
// However it was closed (Esc, outside, ×): stop the video, drop the picture. (The "close" event comes a
// moment after closing: if something opened it again meanwhile, it's that one's now.)
viewer.addEventListener("close", () => {
  if (viewer.open) return;
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  viewerImage.removeAttribute("src");
  viewerItems = [];
});

// ---------- Zooming and dragging ----------
//
// The picture isn't resized: it's moved and stretched with a CSS transform, "translate(x, y)
// scale(s)", which the graphics card draws, so it stays smooth even for big photos. Three numbers
// say where it is: zoom (1 = fitted to the window, as the CSS lays it out), and x, y (how far its
// middle has been moved from the middle of the window, in screen pixels).
//
// Zooming *towards* a point (the mouse, or between two fingers) means the spot of the picture under
// that point stays there. With c the picture's middle before moving (the window's middle), a point p
// on the screen is at u = (p - c - x) / zoom in the picture's own (fitted) pixels. After zooming to
// zoom2, that same u must be under p again: p = c + x2 + u * zoom2, so x2 = p - c - u * zoom2.

const VIEWER_MAX_ZOOM = 8;
let zoom = 1;
let panX = 0;
let panY = 0;
let justDragged = false;  // the picture was dragged: the click that ends it closes nothing

function resetZoom() {
  zoom = 1;
  panX = panY = 0;
  applyZoom();
}

function applyZoom() {
  viewerImage.style.transform = zoom === 1 ? "" : `translate(${panX}px, ${panY}px) scale(${zoom})`;
  viewerImage.classList.toggle("zoomed", zoom > 1);  // (chat.css: the grab cursor)
}

// Keep the picture from being dragged off: zoomed in, its edges may not come inside the window's
// (unless it's smaller than the window that way: then it stays in the middle).
function clampPan() {
  const room = (size, screen) => Math.max(0, (size * zoom - screen) / 2);
  const roomX = room(viewerImage.offsetWidth, window.innerWidth);
  const roomY = room(viewerImage.offsetHeight, window.innerHeight);
  panX = Math.min(roomX, Math.max(-roomX, panX));
  panY = Math.min(roomY, Math.max(-roomY, panY));
}

// Zoom to `newZoom` (kept between 1 and VIEWER_MAX_ZOOM) around the screen point (pointX, pointY).
function zoomAt(newZoom, pointX, pointY) {
  newZoom = Math.min(VIEWER_MAX_ZOOM, Math.max(1, newZoom));
  const middleX = window.innerWidth / 2;
  const middleY = window.innerHeight / 2;
  const u = (pointX - middleX - panX) / zoom;  // the picture's spot under the point (see above)
  const v = (pointY - middleY - panY) / zoom;
  zoom = newZoom;
  panX = pointX - middleX - u * zoom;
  panY = pointY - middleY - v * zoom;
  clampPan();
  applyZoom();
}

// The mouse wheel (and a touchpad pinch, which the browser hands over as a wheel turned with Ctrl
// held). deltaY: how far it turned, positive = towards you = smaller. Math.exp makes every notch the
// same step in or out. passive: false, so preventDefault may stop the page (or the browser) zooming.
viewerImage.addEventListener("wheel", (event) => {
  event.preventDefault();
  const speed = event.ctrlKey ? 0.01 : 0.002;  // (a pinch sends many small turns)
  zoomAt(zoom * Math.exp(-event.deltaY * speed), event.clientX, event.clientY);
}, { passive: false });

// Double-click: from fitted to the picture's real size (at least twice as big) at that spot, or back.
viewerImage.addEventListener("dblclick", (event) => {
  if (!viewerImage.naturalWidth) return;  // (still loading: no real size to go to yet)
  if (zoom > 1) {
    resetZoom();
  } else {
    const realSize = viewerImage.naturalWidth / viewerImage.offsetWidth;
    zoomAt(Math.max(2, realSize), event.clientX, event.clientY);
  }
});

// Dragging and pinching, with pointer events: one kind of event for the mouse, a pen and every
// finger. `pointers` holds where each finger (or the mouse) touching the picture is, by its id.
// One pointer drags; two pinch: the zoom follows the distance between them, around their middle.
const pointers = new Map();
let pinchDistance = null;  // the fingers' distance at the last move, while pinching

viewerImage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;  // (the left button only: right-click keeps its menu)
  viewerImage.setPointerCapture(event.pointerId);  // its moves keep coming here, even off the picture
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
});
// Any new press, on the picture or beside it, starts over: only the click ending a drag is skipped.
viewer.addEventListener("pointerdown", () => {
  justDragged = false;
}, { capture: true });  // (capture: before the picture's own handler above)

viewerImage.addEventListener("pointermove", (event) => {
  const last = pointers.get(event.pointerId);
  if (!last) return;
  const now = { x: event.clientX, y: event.clientY };
  if (pointers.size === 1) {
    if (zoom > 1) {
      panX += now.x - last.x;
      panY += now.y - last.y;
      clampPan();
      applyZoom();
      justDragged = true;
    }
  } else if (pointers.size === 2) {
    pointers.set(event.pointerId, now);
    const [a, b] = pointers.values();
    const distance = Math.hypot(a.x - b.x, a.y - b.y);  // (Pythagoras)
    if (pinchDistance) zoomAt(zoom * (distance / pinchDistance), (a.x + b.x) / 2, (a.y + b.y) / 2);
    pinchDistance = distance;
    justDragged = true;
  }
  pointers.set(event.pointerId, now);
});

function pointerGone(event) {
  pointers.delete(event.pointerId);
  pinchDistance = null;
}
viewerImage.addEventListener("pointerup", pointerGone);
viewerImage.addEventListener("pointercancel", pointerGone);

// The window changed size: the fitted picture did too, so keep it inside the edges.
window.addEventListener("resize", () => {
  if (zoom > 1) {
    clampPan();
    applyZoom();
  }
});
