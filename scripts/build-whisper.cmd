@echo off
rem Builds whisper.cpp (vendor\whisper.cpp) with MSVC + Ninja from the VS 2022 Build Tools.
rem Usage: scripts\build-whisper.cmd [cpu|vulkan]
setlocal
set ROOT=%~dp0..
set VS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
set MODE=%1
if "%MODE%"=="" set MODE=cpu
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
set PATH=%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%
set EXTRA=-DGGML_VULKAN=OFF
if "%MODE%"=="vulkan" set EXTRA=-DGGML_VULKAN=ON
rem GGML_NATIVE=OFF + GGML_CPU_ALL_VARIANTS: one build that picks AVX2/AVX-512 at run time,
rem so the binaries work on other people's CPUs too (needs GGML_BACKEND_DL).
cmake -S "%ROOT%\vendor\whisper.cpp" -B "%ROOT%\build\whisper-%MODE%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF ^
  -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON %EXTRA% ^
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF || exit /b 1
cmake --build "%ROOT%\build\whisper-%MODE%" --config Release -j || exit /b 1
echo BUILD OK
