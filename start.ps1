$scriptDir = Split-Path -LiteralPath $PSCommandPath -Parent
$nodeBin = $null

$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode) {
  $nodeBin = $pathNode.Source
} elseif (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') {
  $nodeBin = 'C:\Program Files\nodejs\node.exe'
}

if (-not $nodeBin) {
  Write-Error 'Node.js was not found in PATH or at C:\Program Files\nodejs\node.exe'
  exit 1
}

& $nodeBin (Join-Path $scriptDir 'server.mjs') --open @args
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  Write-Host "Server exited with code $exitCode."
}
exit $exitCode
