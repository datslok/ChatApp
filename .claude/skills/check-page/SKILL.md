---
name: check-page
description: Use to check CSS or JavaScript of the web page without opening a window: layout measurements, a script's output, a screenshot, in headless Edge.
---

# Checking a page in headless Edge

Invisible and silent, so no need to ask first (unlike `drive-desktop`).

- **Run it with `Start-Process`:** plain `& msedge` prints nothing.

  ```powershell
  Start-Process msedge -ArgumentList "--headless=new", "--user-data-dir=<scratch folder>",
      "--allow-file-access-from-files", "--virtual-time-budget=3000", "--dump-dom", "<file:/// url>" `
      -RedirectStandardOutput <scratch>\dom.html -Wait
  ```

- **Measure, don't eyeball:** have the test page write its measurements (sizes, positions, computed styles) into a
  `<pre>`, and read them from the dumped DOM. `--screenshot` can show a stale layout: trust the numbers.
- **No narrower than about 500 px:** headless Edge cuts off below that. For the phone layout, drive it over
  DevTools as `tools/make_screenshot.py` does.
- **Test videos:** ffmpeg's `-f lavfi -i color=...` or `testsrc`.
- **Throwaway files** go in the scratchpad, never the repo; delete the profile folder after.
