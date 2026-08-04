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
$package = Get-ChildItem -LiteralPath $release -Filter "wawapi-image-mcp-*.tgz" -File | Select-Object -First 1
$checksums = Join-Path $release "SHA256SUMS.txt"
if (-not $package) {
    throw "Release smoke test did not find wawapi-image-mcp-*.tgz"
}
foreach ($required in @($installer, $package.FullName, $checksums)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Release smoke test is missing: $required"
    }
}

$testParent = if (Test-Path -LiteralPath "D:\") {
    "D:\CodexTools\wawapi-image-mcp-tests"
} else {
    Join-Path $env:LOCALAPPDATA "CodexTools\wawapi-image-mcp-tests"
}
New-Item -ItemType Directory -Path $testParent -Force | Out-Null
$testRoot = Join-Path $testParent ("i-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$installRoot = Join-Path $testRoot "wawapi-image-mcp"
$codexHome = Join-Path $testRoot "codex-home"
$originalPath = $env:PATH
$originalKey = $env:WAWAPI_API_KEY
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
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "test-codex-shim.ps1") -Destination (Join-Path $codexDirectory "test-codex-shim.ps1")
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
    $env:WAWAPI_API_KEY = "test-only-key-123456789"

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

    $installText = & $installer @arguments
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
    $registeredText = & $codexCommand.Source mcp get wawapi-image --json
    if ($LASTEXITCODE -ne 0) {
        throw "Codex could not read the smoke-test MCP registration"
    }
    $registered = ($registeredText -join "`n") | ConvertFrom-Json
    if ([int]$registered.tool_timeout_sec -ne 600) {
        throw "Codex did not persist the expected MCP tool timeout"
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
        uninstall_verified = $true
    } | ConvertTo-Json -Depth 4
} finally {
    $env:PATH = $originalPath
    $env:WAWAPI_API_KEY = $originalKey
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
