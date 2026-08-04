Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ConfigPath {
    if (-not $env:CODEX_HOME) {
        throw "CODEX_HOME is required by the test Codex shim"
    }
    return Join-Path $env:CODEX_HOME "config.toml"
}

function Read-ConfigLines([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }
    return @(Get-Content -LiteralPath $Path)
}

function Write-ConfigLines([string]$Path, [string[]]$Lines) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $content = if ($Lines.Count -gt 0) { ($Lines -join "`n") + "`n" } else { "" }
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Find-WawapiSection([string[]]$Lines) {
    $start = -1
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index].Trim() -eq "[mcp_servers.wawapi-image]") {
            $start = $index
            break
        }
    }
    if ($start -lt 0) {
        return $null
    }
    $end = $Lines.Count
    for ($index = $start + 1; $index -lt $Lines.Count; $index++) {
        $trimmed = $Lines[$index].Trim()
        if ($trimmed -match "^\[" -and -not $trimmed.StartsWith("[mcp_servers.wawapi-image")) {
            $end = $index
            break
        }
    }
    return [pscustomobject]@{ start = $start; end = $end }
}

function Remove-WawapiSection([string]$Path) {
    $lines = @(Read-ConfigLines $Path)
    $section = Find-WawapiSection $lines
    if (-not $section) {
        return $false
    }
    $before = if ($section.start -gt 0) { @($lines[0..($section.start - 1)]) } else { @() }
    $after = if ($section.end -lt $lines.Count) { @($lines[$section.end..($lines.Count - 1)]) } else { @() }
    Write-ConfigLines $Path @($before + $after)
    return $true
}

function Read-WawapiRegistration([string]$Path) {
    $lines = @(Read-ConfigLines $Path)
    $section = Find-WawapiSection $lines
    if (-not $section) {
        return $null
    }
    $command = ""
    $timeout = $null
    for ($index = $section.start + 1; $index -lt $section.end; $index++) {
        if ($lines[$index] -match '^\s*command\s*=\s*[''"](.*)[''"]\s*$') {
            $command = $Matches[1].Replace("''", "'")
        } elseif ($lines[$index] -match "^\s*tool_timeout_sec\s*=\s*(\d+)\s*$") {
            $timeout = [int]$Matches[1]
        }
    }
    return [pscustomobject]@{
        command = $command
        tool_timeout_sec = $timeout
    }
}

$arguments = @($args)
if ($arguments.Count -lt 2 -or $arguments[0] -ne "mcp") {
    Write-Error "Unsupported test Codex command"
    exit 2
}

$configPath = Get-ConfigPath
$action = $arguments[1]
switch ($action) {
    "get" {
        $registration = Read-WawapiRegistration $configPath
        if (-not $registration) {
            exit 1
        }
        if ($arguments -contains "--json") {
            [pscustomobject]@{
                name = "wawapi-image"
                enabled = $true
                transport = [pscustomobject]@{
                    type = "stdio"
                    command = $registration.command
                    args = @()
                    env = [pscustomobject]@{}
                    env_vars = @()
                    cwd = $null
                }
                enabled_tools = $null
                disabled_tools = $null
                startup_timeout_sec = $null
                tool_timeout_sec = $registration.tool_timeout_sec
            } | ConvertTo-Json -Depth 5
        } else {
            Write-Output "wawapi-image"
            Write-Output "  command: $($registration.command)"
        }
        exit 0
    }
    "remove" {
        if (Remove-WawapiSection $configPath) {
            exit 0
        }
        exit 1
    }
    "add" {
        if ($arguments.Count -lt 7 -or $arguments[2] -ne "--env" -or $arguments[4] -ne "wawapi-image" -or $arguments[5] -ne "--") {
            Write-Error "Unexpected mcp add arguments"
            exit 2
        }
        Remove-WawapiSection $configPath | Out-Null
        $lines = @(Read-ConfigLines $configPath)
        if ($lines.Count -gt 0 -and $lines[-1] -ne "") {
            $lines += ""
        }
        $command = [string]$arguments[6]
        $escapedCommand = $command.Replace("'", "''")
        $lines += "[mcp_servers.wawapi-image]"
        $lines += "command = '$escapedCommand'"
        Write-ConfigLines $configPath $lines
        exit 0
    }
    default {
        Write-Error "Unsupported test Codex MCP action: $action"
        exit 2
    }
}
