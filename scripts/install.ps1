[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$ChecksumPath,
    [string]$InstallRoot,
    [string]$CodexHome,
    [string]$NodeRuntimeArchive,
    [ValidateSet("openai", "openai-compatible", "gemini", "openrouter")]
    [string]$Provider,
    [string]$BaseUrl,
    [string]$Model,
    [ValidateSet("openai-images", "openai-chat", "gemini")]
    [string]$ApiFormat,
    [string]$ProviderConfigPath,
    [switch]$ResetApiKey,
    [switch]$SkipSkillInstall,
    [switch]$SkipMcpRegistration,
    [switch]$SkipNetworkDoctor,
    [switch]$Friendly,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:IsWindowsPlatform = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$script:ManagedNodeVersion = "24.19.0"
$script:CodexToolTimeoutSec = 600
$script:ManagedNodeArtifacts = @{
    x64 = [ordered]@{
        file_name = "node-v24.19.0-win-x64.zip"
        directory_name = "node-v24.19.0-win-x64"
        sha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
    }
    arm64 = [ordered]@{
        file_name = "node-v24.19.0-win-arm64.zip"
        directory_name = "node-v24.19.0-win-arm64"
        sha256 = "8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f"
    }
}

if (-not $script:IsWindowsPlatform) {
    throw "当前安装器仅支持Windows。MCP源码可在其他平台运行，但需要手动配置。"
}

function Resolve-AbsolutePath([string]$Value) {
    return [System.IO.Path]::GetFullPath($Value)
}

function Assert-SafeInstallRoot([string]$Path) {
    $resolved = Resolve-AbsolutePath $Path
    $driveRoot = [System.IO.Path]::GetPathRoot($resolved)
    if ($resolved.TrimEnd("\") -eq $driveRoot.TrimEnd("\")) {
        throw "InstallRoot不能是驱动器根目录：$resolved"
    }
    if ([System.IO.Path]::GetFileName($resolved.TrimEnd("\")) -ine "universal-image-mcp") {
        throw "InstallRoot必须使用独立的universal-image-mcp目录：$resolved"
    }
    if ($resolved.Length -gt 100) {
        throw "InstallRoot路径过长，Windows PowerShell 5.1无法可靠解压受管运行时。请使用较短路径，例如D:\CodexTools\universal-image-mcp。"
    }
    return $resolved
}

function Get-DefaultInstallRoot {
    if (Test-Path -LiteralPath "D:\") {
        return "D:\CodexTools\universal-image-mcp"
    }
    return Join-Path $env:LOCALAPPDATA "CodexTools\universal-image-mcp"
}

function Get-ResolvedCodexHome([string]$RequestedHome) {
    $value = if ($RequestedHome) {
        $RequestedHome
    } elseif ($env:CODEX_HOME) {
        $env:CODEX_HOME
    } else {
        Join-Path $env:USERPROFILE ".codex"
    }
    return Resolve-AbsolutePath $value
}

function Get-InstallMarkerPath([string]$Path) {
    return Join-Path $Path ".universal-image-mcp-install.json"
}

function Test-OwnedInstallRoot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $false
    }

    $resolved = Resolve-AbsolutePath $Path
    $markerPath = Get-InstallMarkerPath $resolved
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        try {
            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
            if (
                [string]$marker.product -eq "universal-image-mcp" -and
                (Resolve-AbsolutePath ([string]$marker.install_root)) -ieq $resolved
            ) {
                return $true
            }
        } catch {
            return $false
        }
    }

    # Recognize the 1.0.x layout so existing users can safely update or uninstall.
    $packageJsonPath = Join-Path $resolved "node_modules\universal-image-mcp\package.json"
    $commandPath = Join-Path $resolved "universal-image-mcp.cmd"
    if (
        (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) -and
        (Test-Path -LiteralPath $commandPath -PathType Leaf)
    ) {
        try {
            $packageInfo = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
            return [string]$packageInfo.name -eq "universal-image-mcp"
        } catch {
            return $false
        }
    }

    return $false
}

function Assert-InstallRootAvailable([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    $entries = @(Get-ChildItem -LiteralPath $Path -Force)
    if ($entries.Count -eq 0 -or (Test-OwnedInstallRoot $Path)) {
        return
    }
    throw "InstallRoot已存在且不属于Universal Image MCP，请选择空的独立目录：$Path"
}

function Write-InstallMarker([string]$Path, [string]$Version, $RuntimeInfo, [string]$Status = "installed") {
    $markerPath = Get-InstallMarkerPath $Path
    $marker = [ordered]@{
        product = "universal-image-mcp"
        version = $Version
        status = $Status
        install_root = (Resolve-AbsolutePath $Path)
        runtime = if ($RuntimeInfo) {
            [ordered]@{
                kind = "managed_node"
                version = [string]$RuntimeInfo.version
                architecture = [string]$RuntimeInfo.architecture
                node = [string]$RuntimeInfo.node
                source = [string]$RuntimeInfo.source
                archive_sha256 = [string]$RuntimeInfo.archive_sha256
            }
        } else {
            $null
        }
        written_at = [DateTimeOffset]::Now.ToString("o")
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($markerPath, "$marker`n", [System.Text.UTF8Encoding]::new($false))
    return $markerPath
}

function Get-FileSha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Assert-PathWithin([string]$Child, [string]$Parent, [string]$Label) {
    $resolvedChild = Resolve-AbsolutePath $Child
    $resolvedParent = (Resolve-AbsolutePath $Parent).TrimEnd("\") + "\"
    if (-not $resolvedChild.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label必须位于指定目录内：$resolvedParent"
    }
    return $resolvedChild
}

function Get-NodeArchitecture {
    $architecture = [System.Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432")
    if (-not $architecture) {
        $architecture = [System.Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
    }
    switch ([string]$architecture) {
        "AMD64" { return "x64" }
        "ARM64" { return "arm64" }
        default {
            throw "不支持当前Windows架构：$architecture。此版本支持x64和arm64。"
        }
    }
}

function Get-ManagedNodeSpec {
    $architecture = Get-NodeArchitecture
    $artifact = $script:ManagedNodeArtifacts[$architecture]
    if (-not $artifact) {
        throw "没有适用于$architecture的受管Node.js运行时"
    }
    return [pscustomobject]@{
        version = $script:ManagedNodeVersion
        architecture = $architecture
        file_name = [string]$artifact.file_name
        directory_name = [string]$artifact.directory_name
        sha256 = [string]$artifact.sha256
        url = "https://nodejs.org/dist/v$($script:ManagedNodeVersion)/$($artifact.file_name)"
    }
}

function Test-ManagedNodeRuntime([string]$NodePath, [string]$NpmPath, $Spec) {
    if (
        -not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $NpmPath -PathType Leaf)
    ) {
        return $false
    }
    $versionResult = Invoke-NativeCommand $NodePath @("--version") -CaptureOutput
    $architectureResult = Invoke-NativeCommand $NodePath @("-p", "process.arch") -CaptureOutput
    if ($versionResult.exit_code -ne 0 -or $architectureResult.exit_code -ne 0) {
        return $false
    }
    $version = (($versionResult.output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    $architecture = (($architectureResult.output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    return $version -eq "v$($Spec.version)" -and $architecture -eq $Spec.architecture
}

function Invoke-OfficialNodeDownload([string]$Uri, [string]$Destination) {
    if ($Friendly) {
        Write-Host "正在从Node.js官方网站下载受管运行时，请保持网络连接……" -ForegroundColor Cyan
    }
    [System.Net.ServicePointManager]::SecurityProtocol = (
        [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    )
    $downloadParameters = @{
        UseBasicParsing = $true
        Uri = $Uri
        OutFile = $Destination
        TimeoutSec = 180
        Headers = @{ "User-Agent" = "universal-image-mcp-installer/1.3" }
    }
    Invoke-WebRequest @downloadParameters
}

function Install-ManagedNodeRuntime([string]$Root, [string]$ArchiveOverride) {
    $spec = Get-ManagedNodeSpec
    $runtimeParent = Join-Path $Root "runtime"
    $runtimeRoot = Join-Path $runtimeParent $spec.directory_name
    $nodePath = Join-Path $runtimeRoot "node.exe"
    $npmPath = Join-Path $runtimeRoot "npm.cmd"

    if (Test-ManagedNodeRuntime $nodePath $npmPath $spec) {
        return [pscustomobject]@{
            version = $spec.version
            architecture = $spec.architecture
            node = $nodePath
            npm = $npmPath
            root = $runtimeRoot
            source = "reused"
            archive_sha256 = $spec.sha256
            download_url = $spec.url
        }
    }

    New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
    $operationId = [guid]::NewGuid().ToString("N").Substring(0, 8)
    $downloadPath = Join-Path $runtimeParent (".d-" + $operationId + ".zip")
    $extractRoot = Join-Path $runtimeParent (".x-" + $operationId)
    $archivePath = $null
    $source = "downloaded"
    try {
        if ($ArchiveOverride) {
            $archivePath = (Resolve-Path -LiteralPath $ArchiveOverride).Path
            $source = "verified_local_archive"
        } else {
            Invoke-OfficialNodeDownload $spec.url $downloadPath
            $archivePath = $downloadPath
        }

        $archiveHash = Get-FileSha256 $archivePath
        if ($archiveHash -ne $spec.sha256) {
            throw "受管Node.js运行时SHA-256校验失败：$($spec.file_name)"
        }

        New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
        # Keep the temporary path short for Windows PowerShell 5.1's legacy path limits.
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
        $extractedRuntime = Join-Path $extractRoot $spec.directory_name
        $extractedNode = Join-Path $extractedRuntime "node.exe"
        $extractedNpm = Join-Path $extractedRuntime "npm.cmd"
        if (-not (Test-ManagedNodeRuntime $extractedNode $extractedNpm $spec)) {
            throw "下载的受管Node.js运行时未通过版本或架构验证"
        }

        if (Test-Path -LiteralPath $runtimeRoot) {
            $safeRuntimeRoot = Assert-PathWithin $runtimeRoot $runtimeParent "受管运行时目录"
            Remove-Item -LiteralPath $safeRuntimeRoot -Recurse -Force
        }
        Move-Item -LiteralPath $extractedRuntime -Destination $runtimeRoot

        return [pscustomobject]@{
            version = $spec.version
            architecture = $spec.architecture
            node = $nodePath
            npm = $npmPath
            root = $runtimeRoot
            source = $source
            archive_sha256 = $archiveHash
            download_url = $spec.url
        }
    } finally {
        if (Test-Path -LiteralPath $downloadPath) {
            Remove-Item -LiteralPath $downloadPath -Force
        }
        if (Test-Path -LiteralPath $extractRoot) {
            $safeExtractRoot = Assert-PathWithin $extractRoot $runtimeParent "运行时解压临时目录"
            Remove-Item -LiteralPath $safeExtractRoot -Recurse -Force
        }
    }
}

function Write-ManagedMcpLauncher([string]$Root, [string]$NodePath) {
    $resolvedRoot = Resolve-AbsolutePath $Root
    $resolvedNode = Assert-PathWithin $NodePath $resolvedRoot "受管Node.js路径"
    $prefix = $resolvedRoot.TrimEnd("\") + "\"
    $relativeNode = $resolvedNode.Substring($prefix.Length)
    $launcherPath = Join-Path $resolvedRoot "universal-image-mcp.cmd"
    $content = @"
@echo off
setlocal
set "IMAGE_NODE=%~dp0$relativeNode"
set "IMAGE_ENTRY=%~dp0node_modules\universal-image-mcp\bin\universal-image-mcp.mjs"
if not exist "%IMAGE_NODE%" (
  echo Managed Node.js runtime is missing: %IMAGE_NODE% 1>&2
  exit /b 1
)
if not exist "%IMAGE_ENTRY%" (
  echo Universal Image MCP entry point is missing: %IMAGE_ENTRY% 1>&2
  exit /b 1
)
"%IMAGE_NODE%" "%IMAGE_ENTRY%" %*
exit /b %ERRORLEVEL%
"@
    [System.IO.File]::WriteAllText($launcherPath, $content, [System.Text.UTF8Encoding]::new($false))
    return $launcherPath
}

function Assert-PackageChecksum([string]$Path, [string]$SumsPath) {
    if (-not (Test-Path -LiteralPath $SumsPath -PathType Leaf)) {
        throw "缺少SHA256SUMS.txt，无法验证安装包：$SumsPath"
    }
    $fileName = [System.IO.Path]::GetFileName($Path)
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $SumsPath) {
        if ($line -match "^([A-Fa-f0-9]{64})\s{2}(.+)$" -and $Matches[2].Trim() -eq $fileName) {
            $expected = $Matches[1].ToLowerInvariant()
            break
        }
    }
    if (-not $expected) {
        throw "SHA256SUMS.txt中没有安装包记录：$fileName"
    }
    $actual = Get-FileSha256 $Path
    if ($actual -ne $expected) {
        throw "安装包SHA-256校验失败：$fileName"
    }
    return $actual
}

function Set-PrivateStateAcl([string]$Path) {
    if (-not $script:IsWindowsPlatform) {
        return $false
    }

    $rootEntry = Get-Item -LiteralPath $Path -Force
    $children = @(Get-ChildItem -LiteralPath $Path -Recurse -Force)
    $entries = @($rootEntry) + $children
    $reparsePoints = @($entries | Where-Object {
        $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
    })
    if ($reparsePoints.Count -gt 0) {
        throw "状态目录不能包含重解析点"
    }

    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*${currentSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "无法加固状态目录ACL，退出码：$LASTEXITCODE"
    }
    if ($children.Count -gt 0) {
        & icacls.exe "$Path\*" /reset /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "无法让状态文件继承加固后的ACL，退出码：$LASTEXITCODE"
        }
    }
    return $true
}

function Read-ApiKeyFromConfig([string]$ConfigPath) {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return ""
    }
    try {
        $parsed = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        return [string]$parsed.api_key
    } catch {
        return ""
    }
}

function Read-MaskedValue([string]$Prompt) {
    $secureValue = Read-Host $Prompt -AsSecureString
    $pointer = [System.IntPtr]::Zero
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Write-ProtectedConfig([string]$StateRoot, [string]$ApiKey, [hashtable]$ProviderSettings) {
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $aclHardened = Set-PrivateStateAcl $StateRoot
    $configPath = Join-Path $StateRoot "config.json"
    $tempPath = Join-Path $StateRoot (".config." + [guid]::NewGuid().ToString("N") + ".tmp")
    $backupPath = Join-Path $StateRoot (".config." + [guid]::NewGuid().ToString("N") + ".bak")
    try {
        $settings = @{} + $ProviderSettings
        if ($ApiKey) { $settings.api_key = $ApiKey }
        $json = $settings | ConvertTo-Json -Depth 30
        [System.IO.File]::WriteAllText($tempPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
        $validation = Invoke-NativeCommand $runtime.node @((Join-Path $packageRoot "scripts\check-config.mjs"), $tempPath) -CaptureOutput
        if ($validation.exit_code -ne 0) {
            throw "供应商配置校验失败：$(($validation.output | ForEach-Object { [string]$_ }) -join ' ')"
        }
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            [System.IO.File]::Replace($tempPath, $configPath, $backupPath)
        } else {
            [System.IO.File]::Move($tempPath, $configPath)
        }
        $aclHardened = Set-PrivateStateAcl $StateRoot
    } finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force
        }
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
    return [pscustomobject]@{
        path = $configPath
        acl_hardened = $aclHardened
    }
}

function Remove-DirectoryLink([string]$Path) {
    $entry = Get-Item -LiteralPath $Path -Force
    if (-not ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "拒绝删除非联接目录：$Path"
    }
    [System.IO.Directory]::Delete($entry.FullName, $false)
}

function Remove-OwnedSkillLink([string]$SkillTarget, [string]$OwnedRoot) {
    if (-not (Test-Path -LiteralPath $SkillTarget)) {
        return $false
    }
    $entry = Get-Item -LiteralPath $SkillTarget -Force
    if (-not $entry.LinkType) {
        return $false
    }
    $linkTarget = @($entry.Target) -join ""
    if (-not $linkTarget) {
        return $false
    }
    $resolvedTarget = Resolve-AbsolutePath $linkTarget
    $resolvedOwnedRoot = (Resolve-AbsolutePath $OwnedRoot).TrimEnd("\") + "\"
    if (-not $resolvedTarget.StartsWith($resolvedOwnedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    Remove-DirectoryLink $SkillTarget
    return $true
}

function Invoke-NativeCommand(
    [string]$Command,
    [string[]]$Arguments,
    [switch]$CaptureOutput
) {
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 turns native stderr into ErrorRecord objects.
        # Capture those records and decide success only from the process exit code.
        $ErrorActionPreference = "Continue"
        if ($CaptureOutput) {
            $output = @(& $Command @Arguments 2>&1)
        } else {
            & $Command @Arguments *> $null
            $output = @()
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{
        exit_code = $exitCode
        output = $output
    }
}

function Set-CodexMcpToolTimeout(
    [string]$ConfigPath,
    [string]$CodexCommand,
    [int]$TimeoutSec,
    [string[]]$EnvironmentVariables = @()
) {
    if ($TimeoutSec -lt 60 -or $TimeoutSec -gt 3600) {
        throw "Codex MCP工具超时必须在60到3600秒之间"
    }
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Codex MCP注册后没有生成config.toml：$ConfigPath"
    }

    $content = [System.IO.File]::ReadAllText($ConfigPath)
    $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = @([System.Text.RegularExpressions.Regex]::Split($content, "\r?\n"))
    $sectionIndexes = @()
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index].Trim() -eq "[mcp_servers.universal-image]") {
            $sectionIndexes += $index
        }
    }
    if ($sectionIndexes.Count -ne 1) {
        throw "无法唯一定位Codex中的[mcp_servers.universal-image]配置段"
    }

    $sectionStart = $sectionIndexes[0] + 1
    $sectionEnd = $lines.Count
    for ($index = $sectionStart; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^\s*\[[^\]]+\]\s*(?:#.*)?$") {
            $sectionEnd = $index
            break
        }
    }

    $timeoutIndexes = @()
    for ($index = $sectionStart; $index -lt $sectionEnd; $index++) {
        if ($lines[$index] -match "^\s*tool_timeout_sec\s*=") {
            $timeoutIndexes += $index
        }
    }
    if ($timeoutIndexes.Count -gt 1) {
        throw "Codex的universal-image配置段包含重复tool_timeout_sec"
    }
    if ($timeoutIndexes.Count -eq 1) {
        $lines[$timeoutIndexes[0]] = "tool_timeout_sec = $TimeoutSec"
    } else {
        $before = @($lines[0..($sectionStart - 1)])
        $after = if ($sectionStart -lt $lines.Count) {
            @($lines[$sectionStart..($lines.Count - 1)])
        } else {
            @()
        }
        $lines = @($before + "tool_timeout_sec = $TimeoutSec" + $after)
    }

    # Codex filters inherited variables for stdio servers. Forward only names
    # referenced by this provider, without copying credential values to TOML.
    $forwardedNames = @($EnvironmentVariables | Sort-Object -Unique)
    if (@($forwardedNames | Where-Object { $_ -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' }).Count -gt 0) {
        throw "供应商引用了无效的环境变量名称"
    }
    if ($forwardedNames.Count -gt 0) {
        $environmentLine = "env_vars = " + (ConvertTo-Json -InputObject $forwardedNames -Compress)
        $before = @($lines[0..($sectionStart - 1)])
        $after = if ($sectionStart -lt $lines.Count) { @($lines[$sectionStart..($lines.Count - 1)]) } else { @() }
        $lines = @($before + $environmentLine + $after)
    }

    $temporaryPath = "$ConfigPath.universal-image-$([guid]::NewGuid().ToString('N')).tmp"
    $backupPath = "$ConfigPath.universal-image-$([guid]::NewGuid().ToString('N')).bak"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            ($lines -join $newline),
            [System.Text.UTF8Encoding]::new($false)
        )
        [System.IO.File]::Replace($temporaryPath, $ConfigPath, $backupPath)

        $mcpGet = Invoke-NativeCommand $CodexCommand @("mcp", "get", "universal-image", "--json") -CaptureOutput
        if ($mcpGet.exit_code -ne 0) {
            throw "Codex无法读取刚写入的MCP配置，退出码：$($mcpGet.exit_code)"
        }
        $mcpJson = (($mcpGet.output | ForEach-Object { [string]$_ }) -join "`n").Trim()
        $mcpConfig = $mcpJson | ConvertFrom-Json
        if ([int]$mcpConfig.tool_timeout_sec -ne $TimeoutSec) {
            throw "当前Codex未接受MCP工具超时配置。请更新Codex后重新运行安装器。"
        }
        $actualNames = @($mcpConfig.transport.env_vars | Sort-Object -Unique)
        if (($actualNames -join "|") -cne ($forwardedNames -join "|")) {
            throw "当前Codex未保留供应商需要的环境变量转发配置"
        }

        Remove-Item -LiteralPath $backupPath -Force
        return [pscustomobject]@{
            seconds = $TimeoutSec
            verified = $true
            environment_variables = $forwardedNames
        }
    } catch {
        if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
            [System.IO.File]::Replace($backupPath, $ConfigPath, $null)
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

$defaultInstallRoot = Assert-SafeInstallRoot (Get-DefaultInstallRoot)
$InstallRoot = Assert-SafeInstallRoot $(if ($InstallRoot) { $InstallRoot } else { $defaultInstallRoot })
$resolvedCodexHome = Get-ResolvedCodexHome $CodexHome
$skillTarget = Join-Path (Join-Path $resolvedCodexHome "skills") "universal-image"

if ($Uninstall) {
    if ((Test-Path -LiteralPath $InstallRoot) -and -not (Test-OwnedInstallRoot $InstallRoot)) {
        throw "拒绝卸载：目标目录缺少有效的Universal Image MCP所有权标记：$InstallRoot"
    }
    $mcpRemoved = $false
    $mcpOwnershipMismatch = $false
    if (-not $SkipMcpRegistration) {
        $codex = Get-Command codex -ErrorAction SilentlyContinue
        if ($codex) {
            $previousCodexHome = $env:CODEX_HOME
            try {
                $env:CODEX_HOME = $resolvedCodexHome
                $mcpGet = Invoke-NativeCommand $codex.Source @("mcp", "get", "universal-image") -CaptureOutput
                if ($mcpGet.exit_code -eq 0) {
                    $expectedMcpCommand = Join-Path $InstallRoot "universal-image-mcp.cmd"
                    if (($mcpGet.output -join "`n").IndexOf($expectedMcpCommand, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                        $mcpRemove = Invoke-NativeCommand $codex.Source @("mcp", "remove", "universal-image")
                        if ($mcpRemove.exit_code -ne 0) {
                            throw "无法移除Codex MCP注册，退出码：$($mcpRemove.exit_code)"
                        }
                        $mcpRemoved = $true
                    } else {
                        $mcpOwnershipMismatch = $true
                    }
                }
            } finally {
                $env:CODEX_HOME = $previousCodexHome
            }
        }
    }
    $skillRemoved = if ($SkipSkillInstall) { $false } else { Remove-OwnedSkillLink $skillTarget $InstallRoot }
    $configWasPresent = Test-Path -LiteralPath (Join-Path $InstallRoot "state\config.json") -PathType Leaf
    $installRemoved = $false
    if (Test-Path -LiteralPath $InstallRoot) {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
        $installRemoved = $true
    }
    $result = [pscustomobject]@{
        ok = $true
        action = "uninstall"
        install_root = $InstallRoot
        install_removed = $installRemoved
        mcp_removed = $mcpRemoved
        mcp_ownership_mismatch = $mcpOwnershipMismatch
        skill_link_removed = $skillRemoved
        api_key_removed = $configWasPresent -and $installRemoved
    }
    if ($Friendly) {
        Write-Host ""
        Write-Host "卸载完成。" -ForegroundColor Green
        Write-Host "安装目录已移除：$($result.install_removed)"
        Write-Host "MCP注册已移除：$($result.mcp_removed)"
        Write-Host "Skill链接已移除：$($result.skill_link_removed)"
    } else {
        $result | ConvertTo-Json -Depth 4
    }
    return
}

if (-not $PackagePath) {
    $candidate = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "universal-image-mcp-*.tgz" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        throw "安装器目录中没有universal-image-mcp-*.tgz"
    }
    $PackagePath = $candidate.FullName
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if (-not $ChecksumPath) {
    $ChecksumPath = Join-Path (Split-Path -Parent $PackagePath) "SHA256SUMS.txt"
}
$ChecksumPath = (Resolve-Path -LiteralPath $ChecksumPath).Path
$packageSha256 = Assert-PackageChecksum $PackagePath $ChecksumPath

Assert-InstallRootAvailable $InstallRoot

$codex = $null
if (-not $SkipMcpRegistration) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) {
        throw "未找到Codex命令。请先安装或更新Codex，并确认codex命令可在终端中使用。"
    }
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$runtime = Install-ManagedNodeRuntime $InstallRoot $NodeRuntimeArchive
$installMarker = Write-InstallMarker $InstallRoot "installing" $runtime "installing"

$stateRoot = Join-Path $InstallRoot "state"
$configPath = Join-Path $stateRoot "config.json"
$providerSettings = @{}
$connectionChanged = $false
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $savedSettings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($property in $savedSettings.PSObject.Properties) { $providerSettings[$property.Name] = $property.Value }
}
if ($ProviderConfigPath) {
    $suppliedSettings = Get-Content -LiteralPath $ProviderConfigPath -Raw | ConvertFrom-Json
    $providerSettings = @{}
    foreach ($property in $suppliedSettings.PSObject.Properties) { $providerSettings[$property.Name] = $property.Value }
    $connectionChanged = $true
}
if ($Friendly -and $providerSettings.Count -eq 0 -and -not $Provider -and -not $BaseUrl) {
    $Provider = Read-Host "供应商(openai-compatible/openai/gemini/openrouter；回车使用openai-compatible)"
    if (-not $Provider) { $Provider = "openai-compatible" }
    if ($Provider -eq "openai-compatible") { $BaseUrl = Read-Host "API Base URL(包括/v1等前缀)" }
    $Model = Read-Host "图片模型ID(按供应商控制台填写)"
}
if ($Provider -or $BaseUrl -or $ApiFormat) {
    # A new connection must not inherit an old credential, custom auth header,
    # query, or endpoint mapping from a different provider.
    if (-not $ProviderConfigPath) { $providerSettings = @{} }
    $connectionChanged = $true
    if ($Provider) { $providerSettings.provider = $Provider }
    elseif ($BaseUrl) { $providerSettings.provider = "openai-compatible" }
    if ($BaseUrl) { $providerSettings.base_url = $BaseUrl }
    if ($ApiFormat) { $providerSettings.api_format = $ApiFormat }
}
if ($Model) { $providerSettings.model = $Model }
$apiKey = ""
$authSource = ""
$noKeyRequired = $providerSettings.ContainsKey("auth_type") -and $providerSettings.auth_type -eq "none"
if ($noKeyRequired) {
    foreach ($keyField in @("api_key", "apiKey", "api_key_env")) { $providerSettings.Remove($keyField) }
    $authSource = "none"
}
if (-not $noKeyRequired -and -not $ResetApiKey) {
    if ($providerSettings.ContainsKey("api_key")) { $apiKey = [string]$providerSettings.api_key }
    elseif ($providerSettings.ContainsKey("apiKey")) { $apiKey = [string]$providerSettings.apiKey }
    if ($apiKey) {
        $authSource = "existing_config"
    }
}

if (-not $noKeyRequired -and -not $apiKey -and -not $ResetApiKey -and -not $providerSettings.ContainsKey("api_key_env")) {
    if ($env:IMAGE_API_KEY) { $apiKey = [string]$env:IMAGE_API_KEY }
    $authSource = "environment"
}
$environmentReference = $providerSettings.ContainsKey("api_key_env") -and -not $ResetApiKey
if ($environmentReference -and -not $apiKey) { $authSource = "environment_reference" }
if (-not $apiKey -and -not $noKeyRequired -and -not $environmentReference) {
    $apiKey = Read-MaskedValue "请输入当前供应商的API Key"
    $authSource = "prompt"
}
$apiKey = $apiKey.Trim()
if ($apiKey -match "[\r\n]") {
    throw "API Key格式不正确"
}
if ($ResetApiKey) {
    foreach ($keyField in @("api_key", "apiKey", "api_key_env")) { $providerSettings.Remove($keyField) }
}

$npmCache = Join-Path $InstallRoot ".npm-cache"
New-Item -ItemType Directory -Path $npmCache -Force | Out-Null
try {
    if ($Friendly) {
        Write-Host "正在安装MCP与Skill文件……" -ForegroundColor Cyan
    }
    $npmInstall = Invoke-NativeCommand $runtime.npm @(
        "install", "--global", "--prefix", $InstallRoot, $PackagePath,
        "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--cache", $npmCache
    ) -CaptureOutput
    if ($npmInstall.exit_code -ne 0) {
        $npmOutput = (($npmInstall.output | ForEach-Object { [string]$_ }) -join "`n").Trim()
        throw "离线安装MCP依赖失败，退出码：$($npmInstall.exit_code)`n$npmOutput"
    }
} finally {
    if (Test-Path -LiteralPath $npmCache) {
        $safeNpmCache = Assert-PathWithin $npmCache $InstallRoot "npm临时缓存"
        Remove-Item -LiteralPath $safeNpmCache -Recurse -Force
    }
}

$mcpCommand = Write-ManagedMcpLauncher $InstallRoot $runtime.node
if (-not (Test-Path -LiteralPath $mcpCommand -PathType Leaf)) {
    throw "安装后缺少MCP命令：$mcpCommand"
}
$packageRoot = Join-Path $InstallRoot "node_modules\universal-image-mcp"
$skillSource = Join-Path $packageRoot "skills\universal-image"
$doctorScript = Join-Path $packageRoot "scripts\mcp-doctor.mjs"
foreach ($requiredPath in @($skillSource, $doctorScript)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "安装包缺少必要文件：$requiredPath"
    }
}
$installedPackage = Get-Content -LiteralPath (Join-Path $packageRoot "package.json") -Raw | ConvertFrom-Json
$installMarker = Write-InstallMarker $InstallRoot ([string]$installedPackage.version) $runtime

$protectedConfig = Write-ProtectedConfig $stateRoot $apiKey $providerSettings
$env:IMAGE_MCP_HOME = $stateRoot
$forwardedEnvNames = @()
if ($providerSettings.ContainsKey("api_key_env")) { $forwardedEnvNames += [string]$providerSettings.api_key_env }
if ($providerSettings.ContainsKey("header_env")) {
    $headerReferences = $providerSettings.header_env
    if ($headerReferences -is [System.Collections.IDictionary]) { $forwardedEnvNames += @($headerReferences.Values) }
    else { $forwardedEnvNames += @($headerReferences.PSObject.Properties | ForEach-Object { [string]$_.Value }) }
}

$skillBackup = $null
if (-not $SkipSkillInstall) {
    $skillsRoot = Split-Path -Parent $skillTarget
    New-Item -ItemType Directory -Path $skillsRoot -Force | Out-Null
    if (Test-Path -LiteralPath $skillTarget) {
        $existing = Get-Item -LiteralPath $skillTarget -Force
        $existingTarget = @($existing.Target) -join ""
        $replaceKnownLink = $false
        if ($existing.LinkType -and $existingTarget) {
            $resolvedExistingTarget = Resolve-AbsolutePath $existingTarget
            $replaceKnownLink = $resolvedExistingTarget -ieq (Resolve-AbsolutePath $skillSource)
        }
        if ($replaceKnownLink) {
            Remove-DirectoryLink $skillTarget
        } else {
            $skillBackup = Join-Path $skillsRoot ("universal-image.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
            Move-Item -LiteralPath $skillTarget -Destination $skillBackup
        }
    }
    New-Item -ItemType Junction -Path $skillTarget -Target $skillSource | Out-Null
}

$mcpRegistered = $false
$mcpReplaced = $false
$mcpTimeout = $null
if (-not $SkipMcpRegistration) {
    $previousCodexHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = $resolvedCodexHome
        $mcpGet = Invoke-NativeCommand $codex.Source @("mcp", "get", "universal-image")
        if ($mcpGet.exit_code -eq 0) {
            $mcpRemove = Invoke-NativeCommand $codex.Source @("mcp", "remove", "universal-image")
            if ($mcpRemove.exit_code -ne 0) {
                throw "无法替换已有Codex MCP注册，退出码：$($mcpRemove.exit_code)"
            }
            $mcpReplaced = $true
        }
        $mcpAdd = Invoke-NativeCommand $codex.Source @(
            "mcp", "add", "--env", "IMAGE_MCP_CONFIG=$configPath", "universal-image", "--", $mcpCommand
        )
        if ($mcpAdd.exit_code -ne 0) {
            throw "Codex MCP注册失败，退出码：$($mcpAdd.exit_code)"
        }
        $mcpTimeout = Set-CodexMcpToolTimeout `
            (Join-Path $resolvedCodexHome "config.toml") `
            $codex.Source `
            $script:CodexToolTimeoutSec `
            $forwardedEnvNames
        $mcpRegistered = $true
    } finally {
        $env:CODEX_HOME = $previousCodexHome
    }
}

$doctorArguments = @($doctorScript, $mcpCommand, $stateRoot)
if ($SkipNetworkDoctor) {
    $doctorArguments += "--offline"
}
$doctorText = & $runtime.node @doctorArguments
if ($LASTEXITCODE -ne 0) {
    throw "MCP自检执行失败，退出码：$LASTEXITCODE"
}
$doctor = ($doctorText -join "`n") | ConvertFrom-Json

$result = [pscustomobject]@{
    ok = $true
    action = "install"
    install_root = $InstallRoot
    state_root = $stateRoot
    state_acl_hardened = [bool]$protectedConfig.acl_hardened
    auth_source = $authSource
    package_sha256 = $packageSha256
    install_marker = $installMarker
    runtime = [pscustomobject]@{
        kind = "managed_node"
        version = [string]$runtime.version
        architecture = [string]$runtime.architecture
        node = [string]$runtime.node
        source = [string]$runtime.source
        archive_sha256 = [string]$runtime.archive_sha256
        official_download_url = [string]$runtime.download_url
        system_path_required = $false
    }
    mcp_command = $mcpCommand
    mcp_registered = $mcpRegistered
    mcp_replaced = $mcpReplaced
    mcp_tool_timeout_sec = if ($mcpTimeout) { [int]$mcpTimeout.seconds } else { $null }
    mcp_env_vars = if ($mcpTimeout) { @($mcpTimeout.environment_variables) } else { @() }
    mcp_tool_timeout_verified = if ($mcpTimeout) { [bool]$mcpTimeout.verified } else { $false }
    skill_target = if ($SkipSkillInstall) { $null } else { $skillTarget }
    skill_backup = $skillBackup
    tools = $doctor.tools
    content_types = $doctor.content_types
    ready = [bool]$doctor.ready
    doctor_issues = $doctor.issues
    doctor_warnings = $doctor.warnings
    catalog_status = $doctor.catalog_status
    generation_channel_status = $doctor.generation_channel_status
    next_step = if ($doctor.ready) {
        "完全关闭并重新打开Codex，然后新建任务并直接请求生成图片"
    } else {
        "根据doctor_issues处理本地运行时或Key问题，然后重新运行安装器"
    }
}

if ($Friendly) {
    Write-Host ""
    if ($result.ready) {
        Write-Host "安装完成，MCP已经可以使用。" -ForegroundColor Green
    } else {
        Write-Host "安装完成，但本地自检仍有待处理的问题。" -ForegroundColor Yellow
    }
    Write-Host "安装位置：$($result.install_root)"
    Write-Host "受管Node.js：v$($result.runtime.version)（$($result.runtime.architecture)，不依赖系统PATH）"
    Write-Host "MCP注册：$($result.mcp_registered)"
    if ($result.mcp_registered) {
        Write-Host "MCP工具超时：$($result.mcp_tool_timeout_sec)秒（已验证：$($result.mcp_tool_timeout_verified)）"
    }
    Write-Host "Skill位置：$($result.skill_target)"
    Write-Host "可用工具：$($result.tools -join ', ')"
    if (@($result.doctor_issues).Count -gt 0) {
        Write-Host "阻断问题：" -ForegroundColor Red
        foreach ($issue in @($result.doctor_issues)) {
            Write-Host "  - [$($issue.code)] $($issue.message)" -ForegroundColor Red
        }
    }
    if (@($result.doctor_warnings).Count -gt 0) {
        Write-Host "非阻断警告：" -ForegroundColor Yellow
        foreach ($warning in @($result.doctor_warnings)) {
            Write-Host "  - [$($warning.code)] $($warning.message)" -ForegroundColor Yellow
        }
    }
    Write-Host "模型目录状态：$($result.catalog_status)；真实生图渠道：$($result.generation_channel_status)"
    Write-Host "下一步：$($result.next_step)" -ForegroundColor Cyan
} else {
    $result | ConvertTo-Json -Depth 8
}
