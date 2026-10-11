; Our additions to Tauri's installer script (tauri.conf.json: "installerHooks"). Tauri includes this
; file before it sets up the installer's pages, so these settings reach them.

; Scale the sidebar and header pictures to the height of their space and keep their shape. The
; default (FitControl) stretches them to fill it exactly, which makes the cat oval on screens with
; Windows scaling, where the space grows more in one direction than the other.
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight
