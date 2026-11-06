# No host mutations: extract only the pure predicate from its parsed AST.
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Restore-LabAccess.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed.'}
$functions=@($tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-LabSubnetFilter'},$true))
if($functions.Count -ne 1){throw 'Predicate missing or ambiguous.'}
. ([scriptblock]::Create($functions[0].Extent.Text))
if(!(Test-LabSubnetFilter @('192.168.100.0/24'))){throw 'CIDR refused.'}
if(!(Test-LabSubnetFilter @('192.168.100.0/255.255.255.0'))){throw 'Windows normalized subnet refused.'}
foreach($bad in @('Any','LocalSubnet','192.168.0.0/16','192.168.100.67','0.0.0.0/0')){
    if(Test-LabSubnetFilter @($bad)){throw 'Unexpected scope accepted.'}
}
if(Test-LabSubnetFilter @('192.168.100.0/24','Any')){throw 'Extra source accepted.'}
if(Test-LabSubnetFilter @()){throw 'Empty filter accepted.'}
Write-Output 'PASS subnet normalization and refusal cases; no host effects.'
