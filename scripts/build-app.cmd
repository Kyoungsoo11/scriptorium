@echo off
rem Builds native\scriptorium-app.cpp into build\app\Scriptorium.exe (the tray app).
rem Needs only the VS 2022 Build Tools: no whisper.cpp, no extra SDKs.
rem Usage: scripts\build-app.cmd
setlocal
set ROOT=%~dp0..
set OUT=%ROOT%\build\app
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist "%OUT%" mkdir "%OUT%"
rc /nologo /fo "%OUT%\scriptorium-app.res" "%ROOT%\native\scriptorium-app.rc" || exit /b 1
cl /nologo /EHsc /O2 /std:c++17 /utf-8 /W4 /DUNICODE /D_UNICODE /D_CRT_SECURE_NO_WARNINGS ^
  "%ROOT%\native\scriptorium-app.cpp" /Fo"%OUT%\scriptorium-app.obj" /Fe"%OUT%\Scriptorium.exe" ^
  /link /SUBSYSTEM:WINDOWS "%OUT%\scriptorium-app.res" user32.lib shell32.lib comctl32.lib gdi32.lib || exit /b 1
echo BUILD OK
