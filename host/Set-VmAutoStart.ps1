#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$VMId,
    [Parameter(Mandatory)][string]$ExpectedName,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedScriptSha256,
    [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$vm=Get-VM -Id $VMId
if($vm.Name -ne $ExpectedName -or $vm.Generation -ne 2 -or $vm.State -ne 'Running' -or
   $vm.AutomaticStartAction -ne 'Nothing' -or $vm.AutomaticStartDelay -ne 0 -or $vm.AutomaticStopAction -ne 'ShutDown'){
    throw 'Expected the original running lab VM and its previous startup settings.'
}
$record=[ordered]@{vmId=$VMId.ToString();name=$vm.Name;previous='Nothing';previousDelay=0;target='Start';delay=30}
if(!$Apply){$record['mode']='plan';$record|ConvertTo-Json;return}
if(!$SourceCommit -or !$ExpectedScriptSha256 -or (Get-FileHash -LiteralPath $PSCommandPath).Hash -ne $ExpectedScriptSha256){
    throw 'Verified release file and commit required.'
}
Set-VM -VM $vm -AutomaticStartAction Start -AutomaticStartDelay 30
$read=Get-VM -Id $VMId
if($read.Name -ne $ExpectedName -or $read.AutomaticStartAction -ne 'Start' -or
   $read.AutomaticStartDelay -ne 30 -or $read.State -ne 'Running' -or $read.AutomaticStopAction -ne 'ShutDown'){
    throw 'Startup configuration readback failed.'
}
$record['mode']='configured';$record['sourceCommit']=$SourceCommit;$record['hostBootTest']='pending'
$record|ConvertTo-Json
