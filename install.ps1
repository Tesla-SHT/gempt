$ErrorActionPreference = 'Stop'

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$node) { throw 'Node.js 22.13.0 or later is required.' }
$nodeVersion = & $node.Source -v
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.(\d+)' -or
    [int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 13)) {
    throw 'Node.js 22.13.0 or later is required.'
}

$cliArgs = @('install-agy') + $args
if ($args.Count) {
    $remaining = @($args | Select-Object -Skip 1)
    switch ($args[0]) {
        { $_ -in '-PrintMcp', '--print-mcp' } { $cliArgs = @('print-mcp') + $remaining; break }
        { $_ -in '-Help', '-h', '--help' } { $cliArgs = @('--help'); break }
    }
}
& $node.Source (Join-Path $PSScriptRoot 'bin/gempt.mjs') @cliArgs
exit $LASTEXITCODE
