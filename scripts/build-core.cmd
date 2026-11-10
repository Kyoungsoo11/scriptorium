@echo off
rem Builds native\scriptorium-core.cpp against a whisper.cpp build (scripts\build-whisper.cmd first).
rem Usage: scripts\build-core.cmd [cpu|vulkan]
setlocal
set ROOT=%~dp0..
set MODE=%1
if "%MODE%"=="" set MODE=cpu
set W=%ROOT%\vendor\whisper.cpp
set B=%ROOT%\build\whisper-%MODE%
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cl /nologo /EHsc /O2 /std:c++17 /utf-8 /W3 /D_CRT_SECURE_NO_WARNINGS ^
  /I "%W%\include" /I "%W%\ggml\include" "%ROOT%\native\scriptorium-core.cpp" ^
  /Fo"%B%\scriptorium-core.obj" /Fe"%B%\bin\scriptorium-core.exe" ^
  /link "%B%\src\whisper.lib" "%B%\ggml\src\ggml.lib" "%B%\ggml\src\ggml-base.lib" || exit /b 1
echo BUILD OK
