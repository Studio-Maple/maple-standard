# Store a secret in Windows Credential Manager without ever echoing it.
# Usage (run in your own terminal — it prompts for the value):
#   powershell -ExecutionPolicy Bypass -File "$CLAUDE_PLUGIN_ROOT\skills\credential-manager\scripts\store-secret.ps1" -Target <Project>-<Service>-<Purpose>
#
# Writes through Win32 CredWriteW directly. The CredentialManager module's
# New-StoredCredential caps the value at 512 bytes (256 UTF-16 chars) and, when
# it refuses a longer one, its error record carries a truncated copy of the
# secret that PowerShell prints. CredWriteW takes up to 2560 bytes, and every
# failure path here prints a fixed message only. The blob is UTF-16LE, which is
# what Get-StoredCredential(...).GetNetworkCredential().Password reads back.
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [string] $UserName = 'dev'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MapleCredWrite {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);

  public const int MaxBlobBytes = 2560;

  // Returns 0 on success, else the Win32 error code. The value never leaves this method.
  public static int Write(string target, string user, IntPtr bstr, int chars) {
    int bytes = chars * 2;
    if (bytes > MaxBlobBytes) return -1;
    var c = new CREDENTIAL();
    c.Type = 1;            // CRED_TYPE_GENERIC
    c.Persist = 2;         // CRED_PERSIST_LOCAL_MACHINE
    c.TargetName = target;
    c.UserName = user;
    c.CredentialBlobSize = bytes;
    c.CredentialBlob = bstr; // BSTR payload is UTF-16LE, exactly `chars` long
    return CredWriteW(ref c, 0) ? 0 : Marshal.GetLastWin32Error();
  }

  // Length in chars of the stored blob, or -1 if absent. Never returns the value.
  public static int StoredLength(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return -1;
    try { return ((CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL))).CredentialBlobSize / 2; }
    finally { CredFree(p); }
  }
}
'@

if ([MapleCredWrite]::StoredLength($Target) -ge 0) {
  Write-Host "$Target already exists - it will be overwritten." -ForegroundColor Yellow
}

$secure = Read-Host -AsSecureString -Prompt "Paste value for $Target"
$len = $secure.Length
if ($len -eq 0) { Write-Host "Empty value - nothing stored." -ForegroundColor Red; exit 1 }
if ($len * 2 -gt [MapleCredWrite]::MaxBlobBytes) {
  Write-Host "Value is $len chars; Credential Manager holds at most $([MapleCredWrite]::MaxBlobBytes / 2). Nothing stored." -ForegroundColor Red
  exit 1
}

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $rc = [MapleCredWrite]::Write($Target, $UserName, $ptr, $len)
} catch {
  $rc = -2   # swallow: the exception text is never printed
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  $secure.Dispose()
}

if ($rc -ne 0) {
  Write-Host "Could not store $Target (error $rc). Nothing about the value was printed." -ForegroundColor Red
  exit 1
}

$stored = [MapleCredWrite]::StoredLength($Target)
$ok = ($stored -eq $len)
Write-Host "Stored $Target (length $len, verified: $ok)." -ForegroundColor Cyan
if (-not $ok) { exit 1 }
