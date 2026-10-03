# Installs the Claude Code usage board (band above the prompt) and the status line on this machine.
#   powershell -ExecutionPolicy Bypass -File install.ps1            # full install
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipTools # don't install Git / GitHub CLI
param(
    [switch]$SkipTools,
    [string]$ClaudeDir = (Join-Path $HOME '.claude')
)
$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# 1. Tools the board uses: Git (repo / branch / diff row) and GitHub CLI (to clone this kit from GitHub)
if (-not $SkipTools) {
    $tools = @(
        @{ Id = 'Git.Git'; Exe = 'C:\Program Files\Git\cmd\git.exe'; Cmd = 'git' },
        @{ Id = 'GitHub.cli'; Exe = 'C:\Program Files\GitHub CLI\gh.exe'; Cmd = 'gh' }
    )
    foreach ($t in $tools) {
        if ((Get-Command $t.Cmd -ErrorAction SilentlyContinue) -or (Test-Path $t.Exe)) {
            Step "$($t.Id) already installed"
        } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
            Step "Installing $($t.Id) (approve the Windows admin prompt if asked)"
            winget install --id $t.Id -e --silent --accept-package-agreements --accept-source-agreements
        } else {
            Write-Warning "winget not found: install $($t.Id) by hand"
        }
    }
}

# 2. Copy the mod and the status line script
$modDest = Join-Path $ClaudeDir 'mods\usage-board'
Step "Copying the usage board to $modDest"
New-Item -ItemType Directory -Force $modDest | Out-Null
foreach ($part in '.claude-plugin\plugin.json', 'hooks\hooks.json', 'hooks\register.tsx', 'types\index.d.ts') {
    $to = Join-Path $modDest $part
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item (Join-Path $kit "usage-board\$part") $to -Force
}
$statusDest = Join-Path $ClaudeDir 'statusline.ps1'
Copy-Item (Join-Path $kit 'statusline\statusline.ps1') $statusDest -Force

# 3. Merge settings.json (backup first, keep everything already there)
$settingsPath = Join-Path $ClaudeDir 'settings.json'
if (Test-Path $settingsPath) {
    Copy-Item $settingsPath "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
} else {
    $settings = New-Object PSObject
}
if (-not $settings.env) { $settings | Add-Member -NotePropertyName env -NotePropertyValue (New-Object PSObject) -Force }

$modPath = $modDest -replace '\\', '/'
$dirs = @()
if ($settings.env.CLAUDE_CODE_PLUGIN_DIRS) {
    $dirs = $settings.env.CLAUDE_CODE_PLUGIN_DIRS -split ';' | Where-Object { $_ -and ($_ -notmatch 'usage-board/?$') }
}
$dirs += $modPath
$settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue ($dirs -join ';') -Force
$settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIR_WATCH -NotePropertyValue '1' -Force

$statusLine = [PSCustomObject]@{
    type    = 'command'
    command = "powershell -NoProfile -ExecutionPolicy Bypass -File $($statusDest -replace '\\', '/')"
    padding = 0
}
$settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLine -Force

Step "Updating $settingsPath"
$json = $settings | ConvertTo-Json -Depth 32
[IO.File]::WriteAllText($settingsPath, $json, (New-Object Text.UTF8Encoding $false))

Write-Host ''
Write-Host 'Done. Open a new Claude Code session to see the board.' -ForegroundColor Green
