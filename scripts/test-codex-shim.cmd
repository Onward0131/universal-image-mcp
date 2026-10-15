@echo off
"%IMAGE_TEST_NODE%" "%~dp0codex-cli-shim.mjs" %*
exit /b %ERRORLEVEL%
