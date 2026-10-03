# Installs the Claude Code progress board (plan-progress-plus, board edition: bars above the prompt)
# and the status line on this machine.
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
$modDest = Join-Path $ClaudeDir 'mods\plan-progress-plus'
Step "Copying the progress board to $modDest"
New-Item -ItemType Directory -Force $modDest | Out-Null
foreach ($part in '.claude-plugin\plugin.json', 'hooks\hooks.json', 'hooks\register.tsx', 'types\index.d.ts',
                  'skills\plan-progress-plus\SKILL.md', 'sounds\decision.wav', 'sounds\error.wav', 'sounds\done.wav',
                  'LICENSE', 'README.md') {
    $to = Join-Path $modDest $part
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item (Join-Path $kit "plan-progress-plus\$part") $to -Force
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
    # drop earlier copies: the old usage-board and any other plan-progress-plus folder
    # @() keeps a single remaining entry a list, so += appends instead of gluing strings together
    $dirs = @($settings.env.CLAUDE_CODE_PLUGIN_DIRS -split ';' | Where-Object { $_ -and ($_ -notmatch '(usage-board|plan-progress-plus)[\\/]?$') })
}
$dirs += $modPath
$settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue ($dirs -join ';') -Force
$settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIR_WATCH -NotePropertyValue '1' -Force

# the original plan-progress would draw a second set of bars
if ($settings.enabledPlugins -and ($settings.enabledPlugins.PSObject.Properties.Name -contains 'plan-progress@zycck-mods')) {
    $settings.enabledPlugins.'plan-progress@zycck-mods' = $false
    Step 'Turned off the original plan-progress plugin'
}

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
