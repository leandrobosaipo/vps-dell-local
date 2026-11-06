# Evaluate only the capacity-delta expression, without any Hyper-V cmdlets.
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Set-LabCapacity.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed.'}
$assignments=@($tree.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$extra'},$true))
if($assignments.Count -ne 1){throw 'Delta assignment missing or ambiguous.'}
$calculate=[scriptblock]::Create($assignments[0].Extent.Text)
$target=6GB; $vm=[pscustomobject]@{MemoryStartup=2GB}
. $calculate
if($extra -ne 4GB){throw '64-bit delta differs.'}
$vm.MemoryStartup=8GB
. $calculate
if($extra -ne 0){throw 'Negative growth was not clamped.'}
Write-Output 'PASS 64-bit memory budget; no Hyper-V effects.'
