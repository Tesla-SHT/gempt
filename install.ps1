$ErrorActionPreference = 'Stop'

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$node) { throw 'Node.js 20.11.0 or later is required.' }
$nodeVersion = & $node.Source -v
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.(\d+)' -or
    [int]$Matches[1] -lt 20 -or ([int]$Matches[1] -eq 20 -and [int]$Matches[2] -lt 11)) {
    throw 'Node.js 20.11.0 or later is required.'
}

$cliArgs = @('install-agy') + $args
if ($args.Count) {
    $remaining = @($args | Select-Object -Skip 1)
    switch ($args[0]) {
        { $_ -in '-Preview', '--preview' } { $cliArgs = @('presets', '--preview') + $remaining; break }
        { $_ -in '-Apply', '--apply' } { $cliArgs = @('presets', '--apply') + $remaining; break }
        { $_ -in '-PrintMcp', '--print-mcp' } { $cliArgs = @('print-mcp') + $remaining; break }
        { $_ -in '-Help', '-h', '--help' } { $cliArgs = @('--help'); break }
    }
}
& $node.Source (Join-Path $PSScriptRoot 'bin/gempt.mjs') @cliArgs
exit $LASTEXITCODE
