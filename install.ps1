$ErrorActionPreference = 'Stop'

$nativeOptions = @{
    '-Plugin' = '--plugin'
    '-Preview' = '--preview'
    '-Apply' = '--apply'
    '-PrintMcp' = '--print-mcp'
    '-All' = '--all'
    '-Help' = '--help'
    '-Target' = '--target'
    '-Source' = '--source'
    '-Force' = '--force'
    '-MagpieCli' = '--magpie-cli'
}
$installArgs = @(foreach ($argument in $args) {
    if ($nativeOptions.ContainsKey($argument)) { $nativeOptions[$argument] }
    else { $argument }
})

$srcDir = Join-Path $PSScriptRoot 'src'
$bootstrap = 'import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module(''gempt'',run_name=''__main__'')'
$checkVersion = 'import sys; sys.exit(sys.version_info < (3, 10))'

if ($env:PYTHON_BIN) {
    & $env:PYTHON_BIN -I -c $bootstrap $srcDir install @installArgs
    exit $LASTEXITCODE
}
foreach ($candidate in 'python.exe', 'python3.exe', 'py.exe') {
    $python = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$python -or $python.Source -match '[/\\]WindowsApps[/\\]') { continue }
    $pythonArgs = @()
    if ($candidate -eq 'py.exe') { $pythonArgs += '-3' }
    & $python.Source @pythonArgs -I -c $checkVersion 2>$null
    if ($LASTEXITCODE -eq 0) {
        & $python.Source @pythonArgs -I -c $bootstrap $srcDir install @installArgs
        exit $LASTEXITCODE
    }
}
$uv = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($uv) {
    & $uv.Source run --no-project --python '>=3.10' python -I -c $bootstrap $srcDir install @installArgs
    exit $LASTEXITCODE
}
throw 'Python 3.10+ or uv is required. Set PYTHON_BIN to use a specific Python.'
