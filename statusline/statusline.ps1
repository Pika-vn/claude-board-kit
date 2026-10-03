# Claude Code status line: repo/branch, git diff, context window, 5h + weekly limits.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$raw = [Console]::In.ReadToEnd()
try { Set-Content -Path "$PSScriptRoot\statusline-last.json" -Value $raw -Encoding utf8 } catch {}
$d = $raw | ConvertFrom-Json

$e = [char]27
$reset = "$e[0m"; $dim = "$e[2m"
$green = "$e[32m"; $red = "$e[31m"; $blue = "$e[34m"; $cyan = "$e[36m"; $yellow = "$e[33m"

function Bar([double]$leftPct, [string]$color) {
    $w = 10
    $n = [math]::Round([math]::Max(0, [math]::Min(100, $leftPct)) / 100 * $w)
    if ($leftPct -lt 20) { $color = $red } elseif ($leftPct -lt 50) { $color = $yellow }
    "$color" + ([string][char]0x2588 * $n) + "$dim" + ([string][char]0x2591 * ($w - $n)) + "$reset"
}

function ResetIn($ts) {
    if ($null -eq $ts) { return "" }
    try {
        if ($ts -is [string]) { $t = [datetimeoffset]::Parse($ts) }
        else { $t = [datetimeoffset]::FromUnixTimeSeconds([long]$ts) }
        $span = $t - [datetimeoffset]::Now
        if ($span.TotalSeconds -le 0) { return "" }
        if ($span.TotalDays -ge 1) { return " ${dim}reset $([int]$span.Days)d $($span.Hours)h$reset" }
        return " ${dim}reset $([int]$span.TotalHours)h $($span.Minutes)m$reset"
    } catch { return "" }
}

$parts = @()

# Repo + branch + diff
$dir = $d.workspace.current_dir
if (-not $dir) { $dir = $d.cwd }
$seg = "$cyan$(Split-Path $dir -Leaf)$reset"
$branch = $null
if (Get-Command git -ErrorAction SilentlyContinue) { $branch = git -C $dir branch --show-current 2>$null }
if ($branch) {
    $seg += " $dim$branch$reset"
    $stat = git -C $dir diff HEAD --shortstat 2>$null
    $add = 0; $del = 0
    if ($stat -match '(\d+) insertion') { $add = [int]$matches[1] }
    if ($stat -match '(\d+) deletion') { $del = [int]$matches[1] }
    if ($add -or $del) { $seg += " $green+$('{0:N0}' -f $add)$reset $red-$('{0:N0}' -f $del)$reset" }
}
$parts += $seg

# Model
if ($d.model.display_name) { $parts += "$dim$($d.model.display_name)$reset" }

# Context window
$cw = $d.context_window
if ($cw) {
    $left = $cw.remaining_percentage
    if ($null -eq $left -and $null -ne $cw.used_percentage) { $left = 100 - $cw.used_percentage }
    if ($null -ne $left) {
        $txt = "ctx $(Bar $left $blue) $([math]::Round($left))% left"
        if ($cw.context_window_size -and $null -ne $cw.used_percentage) {
            $remK = [math]::Round($cw.context_window_size * $left / 100 / 1000)
            $txt += " $dim(${remK}k)$reset"
        }
        $parts += $txt
    }
}

# Rate limits
$rl = $d.rate_limits
foreach ($k in @(@('five_hour', '5h'), @('seven_day', 'week'))) {
    $r = $rl.($k[0])
    if ($r -and $null -ne $r.used_percentage) {
        $left = 100 - $r.used_percentage
        $parts += "$($k[1]) $(Bar $left $green) $([math]::Round($left))% left$(ResetIn $r.resets_at)"
    }
}

Write-Output ($parts -join " $dim|$reset ")
