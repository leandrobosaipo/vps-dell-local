#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$VMId,
    [Parameter(Mandatory)][string]$ExpectedVMName,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedScriptSha256,
    [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$vm=Get-VM -Id $VMId
if($vm.Name -ne $ExpectedVMName -or $vm.Generation -ne 2 -or [string]$vm.State -ne 'Running'){throw 'Expected running lab VM not found.'}
$target=6GB; $processors=4
$os=Get-CimInstance Win32_OperatingSystem
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$drives=@(Get-VMHardDiskDrive -VM $vm)
if($drives.Count -ne 1){throw 'Unexpected disk count.'}
$vhd=Get-VHD -Path $drives[0].Path
if($vhd.Size -gt 20GB){throw 'Disk ceiling differs from the recorded lab.'}
$free=[long]$os.FreePhysicalMemory*1024
$extra=[math]::Max([long]0,[long]($target-$vm.MemoryStartup))
if($free-$extra -lt 3GB){throw 'Preserve at least 3 GiB host free RAM after the increase.'}
if([long]$disk.FreeSpace-($vhd.Size-$vhd.FileSize)-4GB -lt 25GB){throw 'Windows disk growth/reserve budget failed.'}
$record=[ordered]@{vmId=$VMId.ToString();previousMemory=$vm.MemoryStartup;previousProcessors=$vm.ProcessorCount;
    targetMemory=$target;targetProcessors=$processors;hostFreeMemory=$free;hostDiskFree=[long]$disk.FreeSpace;diskUnchanged=$true;hostReboot=$false}
if($vm.MemoryStartup -eq $target -and $vm.ProcessorCount -eq $processors){$record['mode']='already-configured';$record|ConvertTo-Json;return}
if($vm.MemoryStartup -ne 2GB -or $vm.ProcessorCount -ne 2 -or $vm.DynamicMemoryEnabled){throw 'Initial lab capacity differs; inspect instead of overwriting.'}
if(!$Apply){$record['mode']='plan';$record|ConvertTo-Json;return}
if(!$SourceCommit -or !$ExpectedScriptSha256 -or (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant() -ne $ExpectedScriptSha256){throw 'Verified source required.'}
$folder=Join-Path $env:ProgramData ('vps-dell-local\capacity\'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
$record|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $folder 'before.json') -Encoding UTF8
Stop-VM -VM $vm -Confirm:$false
try {
    $off=Get-VM -Id $VMId
    if([string]$off.State -ne 'Off'){throw 'Guest did not shut down; no capacity mutation.'}
    Set-VMMemory -VM $off -DynamicMemoryEnabled $false -StartupBytes $target
    Set-VMProcessor -VM $off -Count $processors
} finally {
    $current=Get-VM -Id $VMId
    if([string]$current.State -eq 'Off'){Start-VM -VM $current | Out-Null}
}
$read=Get-VM -Id $VMId
if([string]$read.State -ne 'Running' -or $read.MemoryStartup -ne $target -or $read.ProcessorCount -ne $processors){throw 'Capacity readback incomplete; preserve receipt.'}
$record['mode']='configured';$record['sourceCommit']=$SourceCommit;$record['receipt']=$folder
$record|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $folder 'verified.json') -Encoding UTF8
$record|ConvertTo-Json
