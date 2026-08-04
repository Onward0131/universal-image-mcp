[CmdletBinding()]
param(
    [string]$ReleaseRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$packageInfo = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageInfo.version
if ($version -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$") {
    throw "package.json中的版本号无效：$version"
}
$releaseBaseName = "Wawapi-Image-MCP-v$version"
$releaseParent = Join-Path $projectRoot "release"
if (-not $ReleaseRoot) {
    $ReleaseRoot = Join-Path $releaseParent $releaseBaseName
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$releasePrefix = [System.IO.Path]::GetFullPath($releaseParent).TrimEnd("\") + "\"
if (-not $ReleaseRoot.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ReleaseRoot必须位于项目release目录内：$releaseParent"
}

$npm = Get-Command npm.cmd -ErrorAction Stop
New-Item -ItemType Directory -Path $releaseParent -Force | Out-Null
$staging = Join-Path $releaseParent (".wawapi-image-mcp-staging-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $releaseParent "$releaseBaseName.zip"
$zipHashPath = "$zipPath.sha256"
$zipTemp = Join-Path $releaseParent (".$releaseBaseName.$PID.tmp.zip")
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    $dryRun = & $npm.Source pack $projectRoot --dry-run --json --loglevel=error | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $dryRun) {
        throw "npm pack预检失败"
    }
    $packedPaths = @($dryRun[0].files.path)
    $bundledDependencies = @($dryRun[0].bundled)
    $requiredBundledDependencies = @("@modelcontextprotocol/sdk", "zod")
    $missingBundledDependencies = @($requiredBundledDependencies | Where-Object {
        $_ -notin $bundledDependencies
    })
    if ($missingBundledDependencies.Count -gt 0) {
        throw "npm包缺少离线运行依赖：$($missingBundledDependencies -join ', ')"
    }
    $forbidden = @($packedPaths | Where-Object {
        $_ -notmatch "^node_modules/" -and (
            $_ -match "(^|/)(public|launcher|data|output|release)/" -or
            $_ -match "(^|/)(cli|server|start)(\.|/)" -or
            $_ -match "(^|/)\.env(?:\.|$)"
        )
    })
    if ($forbidden.Count -gt 0) {
        throw "npm包包含不允许发布的文件：$($forbidden -join ', ')"
    }

    $sensitivePatterns = @(
        "\bsk-[A-Za-z0-9_-]{24,}\b",
        "\bgh[pousr]_[A-Za-z0-9]{30,}\b",
        (("-" * 5) + "BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY" + ("-" * 5))
    )
    foreach ($relativePath in $packedPaths) {
        if ($relativePath -match "^node_modules/") {
            continue
        }
        $sourcePath = Join-Path $projectRoot $relativePath
        if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
            $content = Get-Content -LiteralPath $sourcePath -Raw -ErrorAction SilentlyContinue
            foreach ($pattern in $sensitivePatterns) {
                if ($content -match $pattern) {
                    throw "发布文件包含疑似凭据：$relativePath"
                }
            }
        }
    }

    & $npm.Source pack $projectRoot --pack-destination $staging --loglevel=error | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "npm pack失败，退出码：$LASTEXITCODE"
    }
    $package = Get-ChildItem -LiteralPath $staging -Filter "wawapi-image-mcp-*.tgz" -File | Select-Object -First 1
    if (-not $package) {
        throw "npm pack没有生成wawapi-image-mcp-*.tgz"
    }

    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install.ps1") -Destination (Join-Path $staging "install.ps1")
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install.cmd") -Destination (Join-Path $staging "install.cmd")
    Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination (Join-Path $staging "README.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "README.en.md") -Destination (Join-Path $staging "README.en.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "CAPABILITIES.md") -Destination (Join-Path $staging "CAPABILITIES.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "CAPABILITIES.en.md") -Destination (Join-Path $staging "CAPABILITIES.en.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "CHANGELOG.md") -Destination (Join-Path $staging "CHANGELOG.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "CONTRIBUTING.md") -Destination (Join-Path $staging "CONTRIBUTING.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination (Join-Path $staging "LICENSE")
    Copy-Item -LiteralPath (Join-Path $projectRoot "SECURITY.md") -Destination (Join-Path $staging "SECURITY.md")

    $releaseTextFiles = @(
        (Join-Path $staging "install.ps1"),
        (Join-Path $staging "install.cmd"),
        (Join-Path $staging "README.md"),
        (Join-Path $staging "README.en.md"),
        (Join-Path $staging "CAPABILITIES.md"),
        (Join-Path $staging "CAPABILITIES.en.md"),
        (Join-Path $staging "CHANGELOG.md"),
        (Join-Path $staging "CONTRIBUTING.md"),
        (Join-Path $staging "LICENSE"),
        (Join-Path $staging "SECURITY.md")
    )
    foreach ($textFile in $releaseTextFiles) {
        $content = Get-Content -LiteralPath $textFile -Raw
        foreach ($pattern in $sensitivePatterns) {
            if ($content -match $pattern) {
                throw "发布目录包含疑似凭据：$([System.IO.Path]::GetFileName($textFile))"
            }
        }
    }

    $hashLines = Get-ChildItem -LiteralPath $staging -File | Sort-Object Name | ForEach-Object {
        $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
        "$($hash.Hash.ToLowerInvariant())  $($_.Name)"
    }
    [System.IO.File]::WriteAllLines(
        (Join-Path $staging "SHA256SUMS.txt"),
        $hashLines,
        [System.Text.UTF8Encoding]::new($false)
    )

    if (Test-Path -LiteralPath $zipTemp) {
        Remove-Item -LiteralPath $zipTemp -Force
    }
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipTemp -CompressionLevel Optimal

    if (Test-Path -LiteralPath $ReleaseRoot) {
        Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force
    }
    Move-Item -LiteralPath $staging -Destination $ReleaseRoot
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Move-Item -LiteralPath $zipTemp -Destination $zipPath

    $zipHash = Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
    [System.IO.File]::WriteAllLines(
        $zipHashPath,
        @("$($zipHash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($zipPath))"),
        [System.Text.UTF8Encoding]::new($false)
    )
    [pscustomobject]@{
        ok = $true
        version = $version
        bundle = $ReleaseRoot
        zip = $zipPath
        zip_sha256 = $zipHash.Hash.ToLowerInvariant()
        zip_sha256_file = $zipHashPath
        package = (Get-ChildItem -LiteralPath $ReleaseRoot -Filter "wawapi-image-mcp-*.tgz" -File | Select-Object -First 1).FullName
        package_file_count = $packedPaths.Count
        project_files = @($packedPaths | Where-Object { $_ -notmatch "^node_modules/" })
        bundled_dependency_count = $bundledDependencies.Count
        required_bundled_dependencies = $requiredBundledDependencies
    } | ConvertTo-Json -Depth 5
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    if (Test-Path -LiteralPath $zipTemp) {
        Remove-Item -LiteralPath $zipTemp -Force
    }
}
