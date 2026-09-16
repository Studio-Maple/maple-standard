# Store a secret in Windows Credential Manager without ever echoing it.
# Usage (run in your own terminal — it prompts for the value):
#   powershell -ExecutionPolicy Bypass -File "$CLAUDE_PLUGIN_ROOT\skills\credential-manager\scripts\store-secret.ps1" -Target <Project>-<Service>-<Purpose>
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [string] $UserName = 'dev'
)

Import-Module CredentialManager -ErrorAction Stop

if (Get-StoredCredential -Target $Target -ErrorAction SilentlyContinue) {
  Write-Host "$Target already exists - it will be overwritten." -ForegroundColor Yellow
}

$secure = Read-Host -AsSecureString -Prompt "Paste value for $Target"
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($plain)) { throw "Empty value - nothing stored." }
  New-StoredCredential -Target $Target -UserName $UserName -Password $plain -Persist LocalMachine | Out-Null
  $len = $plain.Length
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable plain -ErrorAction SilentlyContinue
  [GC]::Collect()
}

$ok = [bool](Get-StoredCredential -Target $Target -ErrorAction SilentlyContinue)
Write-Host "Stored $Target (length $len, verified: $ok)." -ForegroundColor Cyan
