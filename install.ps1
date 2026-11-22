$ErrorActionPreference = 'Stop'

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$node) { throw 'Node.js 20.11.0 or later is required.' }
& $node.Source -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major < 20 || (major === 20 && minor < 11) ? 1 : 0)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 20.11.0 or later is required.' }

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
