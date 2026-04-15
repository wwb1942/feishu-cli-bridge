$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = if ($args.Count -gt 0) { $args[0] } else { Join-Path $Root '.env.feishu-browser' }

if (!(Test-Path $EnvFile)) {
    Write-Error "Missing env file: $EnvFile"
}

Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
        return
    }
    $separatorIndex = $line.IndexOf('=')
    if ($separatorIndex -le 0) {
        return
    }
    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    if (![string]::IsNullOrWhiteSpace($key)) {
        [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

Set-Location $Root
node src/launcher.js
