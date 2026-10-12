@echo off
rem Refreshes Windows' icons: for when ChatApp (or any program) still shows its old icon in the
rem taskbar, Start menu or on the desktop after an update. Windows keeps a cache of every icon it has
rem shown and doesn't always notice when a program's icon changes.
rem
rem Double-click it. The taskbar disappears for a moment and comes back; nothing else closes.
rem A .bat file (not PowerShell) so it also runs when downloaded, for example from the chat.

echo Refreshing Windows' icons. The taskbar disappears for a moment...

rem 1. Stop Explorer (the taskbar, Start menu and desktop), so it lets go of its cache files.
taskkill /f /im explorer.exe >nul 2>&1

rem 2. Delete the cache files. Windows makes new ones, filled from the programs themselves.
del /f /q "%LOCALAPPDATA%\IconCache.db" >nul 2>&1
del /f /q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db" >nul 2>&1

rem 3. Start Explorer again, unless Windows already did (then starting it would open a folder window).
rem (Waiting 2 seconds: three pings to this PC itself, one second apart.)
ping -n 3 127.0.0.1 >nul
tasklist /fi "imagename eq explorer.exe" | find /i "explorer.exe" >nul || start explorer.exe

echo.
echo Done. If a program pinned to the taskbar still shows its old icon, unpin it and pin it again.
echo.
pause
