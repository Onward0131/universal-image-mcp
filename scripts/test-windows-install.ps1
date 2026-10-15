[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,
    [string]$NodeRuntimeArchive,
    [switch]$UseInstalledCodex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Windows installer smoke test requires Windows"
}

$release = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$installer = Join-Path $release "install.ps1"
$package = Get-ChildItem -LiteralPath $release -Filter "universal-image-mcp-*.tgz" -File | Select-Object -First 1
$checksums = Join-Path $release "SHA256SUMS.txt"
if (-not $package) {
    throw "Release smoke test did not find universal-image-mcp-*.tgz"
}
foreach ($required in @($installer, $package.FullName, $checksums)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Release smoke test is missing: $required"
    }
}

$testParent = if (Test-Path -LiteralPath "D:\") {
    "D:\CodexTools\universal-image-mcp-tests"
} else {
    Join-Path $env:LOCALAPPDATA "CodexTools\universal-image-mcp-tests"
}
New-Item -ItemType Directory -Path $testParent -Force | Out-Null
$testRoot = Join-Path $testParent ("i-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$installRoot = Join-Path $testRoot "universal-image-mcp"
$codexHome = Join-Path $testRoot "codex-home"
$originalPath = $env:PATH
$originalImageKey = $env:IMAGE_API_KEY
$originalImageConfig = $env:IMAGE_MCP_CONFIG
$originalImageHome = $env:IMAGE_MCP_HOME
$originalTestHeader = $env:IMAGE_TEST_HEADER
$originalTestNode = $env:IMAGE_TEST_NODE
$originalCodexHome = $env:CODEX_HOME
$installedCodexSource = if ($UseInstalledCodex) {
    (Get-Command codex -ErrorAction Stop).Source
} else {
    $null
}

try {
    New-Item -ItemType Directory -Path $testRoot,$codexHome -Force | Out-Null
    if ($UseInstalledCodex) {
        $codexDirectory = Split-Path -Parent $installedCodexSource
    } else {
        $codexDirectory = Join-Path $testRoot "codex-shim"
        New-Item -ItemType Directory -Path $codexDirectory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "test-codex-shim.cmd") -Destination (Join-Path $codexDirectory "codex.cmd")
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "codex-cli-shim.mjs") -Destination (Join-Path $codexDirectory "codex-cli-shim.mjs")
        $testArchitecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
        $env:IMAGE_TEST_NODE = Join-Path $installRoot "runtime\node-v24.19.0-win-$testArchitecture\node.exe"
    }
    $env:PATH = @(
        $codexDirectory,
        (Join-Path $env:SystemRoot "System32"),
        $env:SystemRoot,
        (Join-Path $env:SystemRoot "System32\Wbem")
    ) -join ";"
    if (Get-Command node -ErrorAction SilentlyContinue) {
        throw "No-Node smoke test unexpectedly found node on the reduced PATH"
    }
    $codexCommand = Get-Command codex -ErrorAction Stop
    $env:IMAGE_API_KEY = "test-only-key-123456789"
    $env:IMAGE_MCP_CONFIG = Join-Path $testRoot "unrelated-config.json"

    $arguments = @{
        PackagePath = $package.FullName
        ChecksumPath = $checksums
        InstallRoot = $installRoot
        CodexHome = $codexHome
        SkipNetworkDoctor = $true
    }
    if ($NodeRuntimeArchive) {
        $arguments.NodeRuntimeArchive = (Resolve-Path -LiteralPath $NodeRuntimeArchive).Path
    }

    $firstArguments = @{} + $arguments
    $firstArguments.Provider = "openai-compatible"
    $firstArguments.BaseUrl = "https://provider.example/v1"
    $firstArguments.Model = "image-test"
    $installText = & $installer @firstArguments
    $installed = ($installText -join "`n") | ConvertFrom-Json
    if (-not $installed.ok -or -not $installed.ready) {
        throw "Offline installer smoke test was not ready: $($installText -join '`n')"
    }
    if ($installed.runtime.version -ne "24.19.0" -or $installed.runtime.system_path_required) {
        throw "Installer did not select the expected managed runtime"
    }
    if (-not ([string]$installed.runtime.node).StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Managed Node.js escaped the test installation root"
    }
    if (-not (Test-Path -LiteralPath $installed.mcp_command -PathType Leaf)) {
        throw "Managed MCP launcher was not installed"
    }
    if (-not (Test-Path -LiteralPath $installed.skill_target)) {
        throw "Skill junction was not installed"
    }
    if (
        -not $installed.mcp_registered -or
        -not $installed.mcp_tool_timeout_verified -or
        [int]$installed.mcp_tool_timeout_sec -ne 600
    ) {
        throw "Installer did not register and verify the 600-second MCP tool timeout"
    }

    $env:CODEX_HOME = $codexHome
    $registeredText = & $codexCommand.Source mcp get universal-image --json
    if ($LASTEXITCODE -ne 0) {
        throw "Codex could not read the smoke-test MCP registration"
    }
    $registered = ($registeredText -join "`n") | ConvertFrom-Json
    if ([int]$registered.tool_timeout_sec -ne 600) {
        throw "Codex did not persist the expected MCP tool timeout"
    }
    if ($registered.transport.env.IMAGE_MCP_CONFIG -ne (Join-Path $installRoot "state\config.json")) {
        throw "Codex registration did not isolate the installed provider configuration"
    }

    # Import a keyless local provider without contacting it, then upgrade again
    # with no provider arguments. The complete connection must survive updates.
    $providerPath = Join-Path $testRoot "provider.json"
    $providerJson = '{"provider":"openai-compatible","base_url":"http://127.0.0.1:9876/v1","model":"local-art","auth_type":"none","api_key":"unused-imported-key","apiKey":"unused-legacy-key","api_key_env":"IMAGE_API_KEY","header_env":{"X-Test-Token":"IMAGE_TEST_HEADER"},"probe_models":false,"extra_body":{"seed":42}}'
    [System.IO.File]::WriteAllText($providerPath, $providerJson, [System.Text.UTF8Encoding]::new($false))
    $env:IMAGE_API_KEY = "unrelated-environment-key"
    $env:IMAGE_TEST_HEADER = "test-only-forwarded-header"
    $providerArguments = @{} + $arguments
    $providerArguments.ProviderConfigPath = $providerPath
    $providerInstall = (& $installer @providerArguments) -join "`n" | ConvertFrom-Json
    if (-not $providerInstall.ready) { throw "Imported local provider was not ready" }
    $updatedInstall = (& $installer @arguments) -join "`n" | ConvertFrom-Json
    $savedProvider = Get-Content -LiteralPath (Join-Path $installRoot "state\config.json") -Raw | ConvertFrom-Json
    if (-not $updatedInstall.ready -or $savedProvider.base_url -ne "http://127.0.0.1:9876/v1" -or $savedProvider.extra_body.seed -ne 42) {
        throw "Provider configuration did not survive a no-argument upgrade"
    }
    if (@($savedProvider.PSObject.Properties.Name | Where-Object { $_ -in @("api_key", "apiKey", "api_key_env") }).Count -gt 0) {
        throw "Switching to local provider unexpectedly retained the old API key"
    }
    $registeredProvider = (& $codexCommand.Source mcp get universal-image --json) -join "`n" | ConvertFrom-Json
    if (($registeredProvider.transport.env_vars -join ",") -ne "IMAGE_TEST_HEADER") {
        throw "Provider header environment variable was not forwarded"
    }
    $codexConfigText = Get-Content -LiteralPath (Join-Path $codexHome "config.toml") -Raw
    if ($codexConfigText.Contains($env:IMAGE_TEST_HEADER) -or $codexConfigText.Contains($env:IMAGE_API_KEY)) {
        throw "Codex registration unexpectedly persisted environment credentials"
    }

    $uninstallArguments = @{
        InstallRoot = $installRoot
        CodexHome = $codexHome
        Uninstall = $true
    }
    $uninstallText = & $installer @uninstallArguments
    $uninstalled = ($uninstallText -join "`n") | ConvertFrom-Json
    if (
        -not $uninstalled.ok -or
        -not $uninstalled.install_removed -or
        -not $uninstalled.skill_link_removed -or
        -not $uninstalled.mcp_removed
    ) {
        throw "Installer uninstall smoke test failed"
    }

    [pscustomobject]@{
        ok = $true
        powershell = $PSVersionTable.PSVersion.ToString()
        runtime_version = [string]$installed.runtime.version
        runtime_architecture = [string]$installed.runtime.architecture
        runtime_source = [string]$installed.runtime.source
        no_system_node = $true
        offline_dependencies = $true
        mcp_tool_timeout_sec = [int]$installed.mcp_tool_timeout_sec
        mcp_tool_timeout_verified = [bool]$installed.mcp_tool_timeout_verified
        codex_driver = if ($UseInstalledCodex) { "installed_codex" } else { "test_shim" }
        skill_installed = $true
        provider_import_and_upgrade_verified = $true
        provider_config_isolation_verified = $true
        keyless_credentials_removed = $true
        environment_names_forwarded_without_values = $true
        uninstall_verified = $true
    } | ConvertTo-Json -Depth 4
} finally {
    $env:PATH = $originalPath
    $env:IMAGE_API_KEY = $originalImageKey
    $env:IMAGE_MCP_CONFIG = $originalImageConfig
    $env:IMAGE_MCP_HOME = $originalImageHome
    $env:IMAGE_TEST_HEADER = $originalTestHeader
    $env:IMAGE_TEST_NODE = $originalTestNode
    $env:CODEX_HOME = $originalCodexHome
    $resolvedRoot = [System.IO.Path]::GetFullPath($testRoot)
    $resolvedParent = [System.IO.Path]::GetFullPath($testParent).TrimEnd("\") + "\"
    if (
        $resolvedRoot.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedRoot)
    ) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
