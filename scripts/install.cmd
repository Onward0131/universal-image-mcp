@echo off
setlocal

set "WAWAPI_PS="
where pwsh.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 set "WAWAPI_PS=pwsh.exe"

if not defined WAWAPI_PS if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "WAWAPI_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not defined WAWAPI_PS (
  echo No supported PowerShell runtime was found.
  echo Windows 10 or Windows 11 is required.
  set "WAWAPI_EXIT=1"
  goto finish
)

echo Wawapi Image MCP installer
echo Keep this window open and enter your API Key when prompted.
echo A verified portable Node.js runtime will be installed automatically if needed.
echo No administrator access or system PATH change is required.
echo.

"%WAWAPI_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Friendly %*
set "WAWAPI_EXIT=%ERRORLEVEL%"

if not "%WAWAPI_EXIT%"=="0" (
  echo.
  echo Installation did not finish. Review the error above, then try again.
)

:finish
if not defined WAWAPI_IMAGE_NO_PAUSE pause
exit /b %WAWAPI_EXIT%
