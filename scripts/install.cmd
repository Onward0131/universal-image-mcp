@echo off
setlocal

set "IMAGE_PS="
where pwsh.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 set "IMAGE_PS=pwsh.exe"

if not defined IMAGE_PS if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "IMAGE_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not defined IMAGE_PS (
  echo No supported PowerShell runtime was found.
  echo Windows 10 or Windows 11 is required.
  set "IMAGE_EXIT=1"
  goto finish
)

echo Universal Image MCP installer
echo Keep this window open and enter your API Key when prompted.
echo A verified portable Node.js runtime will be installed automatically if needed.
echo No administrator access or system PATH change is required.
echo.

"%IMAGE_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Friendly %*
set "IMAGE_EXIT=%ERRORLEVEL%"

if not "%IMAGE_EXIT%"=="0" (
  echo.
  echo Installation did not finish. Review the error above, then try again.
)

:finish
if not defined IMAGE_NO_PAUSE pause
exit /b %IMAGE_EXIT%
