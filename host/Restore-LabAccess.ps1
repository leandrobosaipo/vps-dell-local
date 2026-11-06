#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9+/]{40,}={0,2}$')][string]$LabPublicKey,
    [Parameter(Mandatory)][string]$ExpectedComputerName,
    [Parameter(Mandatory)][guid]$VMId,
    [Parameter(Mandatory)][string]$ExpectedVMName,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedScriptSha256,
    [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Test-LabSubnetFilter([string[]]$Addresses) {
    return @($Addresses).Count -eq 1 -and $Addresses[0] -in @('192.168.100.0/24','192.168.100.0/255.255.255.0')
}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Abra o PowerShell como administrador.'}
if($env:COMPUTERNAME -ne $ExpectedComputerName){throw 'Computador diferente do laboratorio esperado.'}
$network='192.168.100.0/24'
$addresses=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.AddressState -eq 'Preferred' -and $_.IPAddress -like '192.168.100.*'})
if(!$addresses.Count){throw 'Rede local esperada nao encontrada. Nenhuma alteracao aplicada.'}
$keys=Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$original=[IO.File]::ReadAllText($keys)
$pattern='(^|\s)ssh-ed25519\s+'+[regex]::Escape($LabPublicKey)+'(\s|$)'
$matching=@(($original -split '\r?\n') | Where-Object {$_ -match $pattern})
if($matching.Count -ne 1 -or $matching[0].TrimStart().StartsWith('#')){throw 'Chave do laboratorio ausente, duplicada ou comentada. Nada alterado.'}
$newLine='from="'+$network+'",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 '+$LabPublicKey+' vps-dell-local-lab'
$replacement=$original.Replace($matching[0],$newLine)
$acl=(Get-Acl -LiteralPath $keys).Sddl
$firewall=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'
$vm=Get-VM -Id $VMId
if($vm.Name -ne $ExpectedVMName -or $vm.Generation -ne 2 -or [string]$vm.State -notin @('Running','Off','Saved')){throw 'Identidade ou estado da VM inesperado.'}
$sshd=Get-Service sshd
$vmms=Get-Service vmms
$sshdExe=Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
& $sshdExe -t
if($LASTEXITCODE -ne 0){throw 'Configuracao atual do sshd invalida. Nada alterado.'}
$before=[ordered]@{at=[DateTime]::UtcNow.ToString('o');computer=$env:COMPUTERNAME;vmId=$VMId.ToString();
    keySha256=(Get-FileHash -LiteralPath $keys -Algorithm SHA256).Hash;keyAcl=$acl;
    firewallEnabled=[string]$firewall.Enabled;firewallRemoteAddress=@($firewall | Get-NetFirewallAddressFilter | Select-Object -ExpandProperty RemoteAddress);
    sshdStartType=[string]$sshd.StartType;vmmsStartType=[string]$vmms.StartType;
    vmAutoStart=[string]$vm.AutomaticStartAction;vmDelay=$vm.AutomaticStartDelay;vmStop=[string]$vm.AutomaticStopAction}
if(!$Apply){[ordered]@{mode='plan';network=$network;keyHasExpiry=$false;previous=$before}|ConvertTo-Json -Depth 6;return}
if(!$SourceCommit -or !$ExpectedScriptSha256 -or (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedScriptSha256){throw 'Fonte e hash verificados sao obrigatorios.'}
$receipt=Join-Path $env:ProgramData ('vps-dell-local\access-recovery\'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $receipt | Out-Null
& icacls.exe $receipt /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Nao foi possivel proteger a pasta de backup.'}
Copy-Item -LiteralPath $keys -Destination (Join-Path $receipt 'administrators_authorized_keys.before')
$before | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $receipt 'before.json') -Encoding UTF8
& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP | Out-File -LiteralPath (Join-Path $receipt 'power-sleep-before.txt') -Encoding UTF8
& powercfg.exe /query SCHEME_CURRENT SUB_BUTTONS | Out-File -LiteralPath (Join-Path $receipt 'power-buttons-before.txt') -Encoding UTF8
try {
    [IO.File]::WriteAllText($keys,$replacement,[Text.UTF8Encoding]::new($false))
    if([IO.File]::ReadAllText($keys) -cne $replacement -or (Get-Acl -LiteralPath $keys).Sddl -cne $acl){throw 'Verificacao da chave/ACL falhou.'}
} catch {
    [IO.File]::WriteAllText($keys,$original,[Text.UTF8Encoding]::new($false))
    throw
}
$firewall | Set-NetFirewallRule -Enabled True -RemoteAddress $network
Set-Service sshd -StartupType Automatic
Start-Service sshd
Set-Service vmms -StartupType Automatic
Start-Service vmms
Set-VM -VM $vm -AutomaticStartAction Start -AutomaticStartDelay 30 -AutomaticStopAction ShutDown
if([string]$vm.State -in @('Off','Saved')){Start-VM -VM $vm | Out-Null}
& powercfg.exe /change standby-timeout-ac 0
if($LASTEXITCODE -ne 0){throw 'Falha ao configurar suspensao na tomada. Consulte o backup.'}
& powercfg.exe /change hibernate-timeout-ac 0
if($LASTEXITCODE -ne 0){throw 'Falha ao configurar hibernacao na tomada. Consulte o backup.'}
& powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
if($LASTEXITCODE -ne 0){throw 'Falha ao configurar tampa na tomada. Consulte o backup.'}
& powercfg.exe /setactive SCHEME_CURRENT
if($LASTEXITCODE -ne 0){throw 'Falha ao aplicar plano de energia. Consulte o backup.'}
$currentVM=Get-VM -Id $VMId
$currentSSH=Get-Service sshd
$remote=@(Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Get-NetFirewallAddressFilter | Select-Object -ExpandProperty RemoteAddress)
if([string]$currentSSH.Status -ne 'Running' -or [string]$currentSSH.StartType -ne 'Automatic' -or !(Test-LabSubnetFilter $remote) -or [string]$currentVM.State -ne 'Running' -or [string]$currentVM.AutomaticStartAction -ne 'Start' -or $currentVM.AutomaticStartDelay -ne 30){throw 'Readback incompleto. Preserve o backup e envie a saida.'}
$result=[ordered]@{mode='configured';computer=$env:COMPUTERNAME;ipv4=@($addresses | Select-Object -ExpandProperty IPAddress);
    ssh='Running';sshStartup='Automatic';allowedNetwork=$network;labKeyExpiry='none';
    vm=[string]$currentVM.Name;vmState=[string]$currentVM.State;vmStartup='Start';vmDelaySeconds=30;
    rebootTest='pending';sourceCommit=$SourceCommit;backup=$receipt;productionChanged=$false}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $receipt 'verified.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 5
