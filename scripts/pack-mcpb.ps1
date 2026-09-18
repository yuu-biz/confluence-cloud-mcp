$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $root 'mcpb'
$serverDir = Join-Path $bundle 'server'
$dist = Join-Path $root 'dist'

New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
Get-ChildItem -LiteralPath $serverDir -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $dist '*') -Destination $serverDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $bundle 'LICENSE') -Force

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCommand) { throw 'npm is required to collect MCPB production dependencies.' }

$rootNodeModules = Join-Path $root 'node_modules'
$runtimePackages = @(& $npmCommand.Source ls --omit=dev --all --parseable 2>$null)
if ($LASTEXITCODE -ne 0 -or $runtimePackages.Count -lt 2) { throw 'Could not resolve production dependency paths.' }
foreach ($packagePath in $runtimePackages) {
  if (-not $packagePath.StartsWith($rootNodeModules, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
  $relativePath = $packagePath.Substring($root.Length + 1)
  $destination = Join-Path $bundle $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $packagePath -Destination $destination -Recurse -Force
}

$mcpbCommand = Get-Command npx -ErrorAction SilentlyContinue
if (-not $mcpbCommand) {
  $mcpbCommand = Get-Command (Join-Path $env:ProgramFiles 'nodejs\npx.cmd') -ErrorAction SilentlyContinue
}
if (-not $mcpbCommand) { throw 'npx is required to package the MCPB extension.' }

Push-Location $bundle
try {
  & $mcpbCommand.Source @('--yes', '@anthropic-ai/mcpb@2.1.2', 'validate', 'manifest.json')
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'dist') | Out-Null
  & $mcpbCommand.Source @('--yes', '@anthropic-ai/mcpb@2.1.2', 'pack', '.', (Join-Path $root 'dist\confluence-cloud-mcp.mcpb'))
  if ($LASTEXITCODE -ne 0) { throw 'mcpb pack failed.' }
}
finally {
  Pop-Location
}
