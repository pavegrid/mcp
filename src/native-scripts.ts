// Static helper code only. Requests and secrets travel through private pipes.
// Never pass a secret in command arguments, environment, or a script file.
export const MAC_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');
function run() {
  try {
    $.SecKeychainSetUserInteractionAllowed(false);
    var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var req = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
    var kc = Ref();
    var code = req.keychain ? $.SecKeychainOpen(req.keychain, kc) : $.SecKeychainCopyDefault(kc);
    if (code !== 0) return JSON.stringify({status: 'unavailable'});
    var state = Ref();
    if ($.SecKeychainGetStatus(ObjC.castRefToObject(kc[0]), state) !== 0) return JSON.stringify({status: 'unavailable'});
    if ((state[0] & 1) === 0) return JSON.stringify({status: 'locked'});
    var q = $.NSMutableDictionary.alloc.init;
    q.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass));
    q.setObjectForKey($(req.service), ObjC.castRefToObject($.kSecAttrService));
    q.setObjectForKey($('pavegrid'), ObjC.castRefToObject($.kSecAttrAccount));
    q.setObjectForKey($.NSArray.arrayWithObject(ObjC.castRefToObject(kc[0])), ObjC.castRefToObject($.kSecMatchSearchList));
    function status(c) {
      if (c === 0) return 'ok';
      if (c === -25300) return 'missing';
      if (c === -25293 || c === -25294 || c === -25308) return 'denied';
      return 'unavailable';
    }
    if (req.action === 'read') {
      q.setObjectForKey(ObjC.castRefToObject($.kCFBooleanTrue), ObjC.castRefToObject($.kSecReturnData));
      q.setObjectForKey(ObjC.castRefToObject($.kSecMatchLimitOne), ObjC.castRefToObject($.kSecMatchLimit));
      var out = Ref();
      code = $.SecItemCopyMatching(q, out);
      if (code !== 0) return JSON.stringify({status: status(code)});
      return JSON.stringify({status: 'ok', token: ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(out[0]), $.NSUTF8StringEncoding))});
    }
    if (req.action === 'remove') return JSON.stringify({status: status($.SecItemDelete(q))});
    if (req.action === 'write') {
      var data = $(req.token).dataUsingEncoding($.NSUTF8StringEncoding);
      var update = $.NSMutableDictionary.alloc.init;
      update.setObjectForKey(data, ObjC.castRefToObject($.kSecValueData));
      code = $.SecItemUpdate(q, update);
      if (code === -25300) {
        q.removeObjectForKey(ObjC.castRefToObject($.kSecMatchSearchList));
        q.setObjectForKey(ObjC.castRefToObject(kc[0]), ObjC.castRefToObject($.kSecUseKeychain));
        q.setObjectForKey(data, ObjC.castRefToObject($.kSecValueData));
        code = $.SecItemAdd(q, null);
      }
      return JSON.stringify({status: status(code)});
    }
    return JSON.stringify({status: 'unavailable'});
  } catch (_) { return JSON.stringify({status: 'unavailable'}); }
}
`;

export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# A Node child of PowerShell 7 can inherit incompatible PowerShell 7 modules.
# Restrict this helper process to the modules bundled with Windows PowerShell.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaveGridCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void Free(IntPtr credential);
  // Capture the native error before returning to PowerShell, whose own calls
  // can replace the thread's last-error value during argument/function binding.
  public static int Write(ref Credential credential, uint flags) {
    return CredWrite(ref credential, flags) ? 0 : Marshal.GetLastWin32Error();
  }
  public static int Read(string target, uint type, uint flags, out IntPtr credential) {
    return CredRead(target, type, flags, out credential) ? 0 : Marshal.GetLastWin32Error();
  }
  public static int Delete(string target, uint type, uint flags) {
    return CredDelete(target, type, flags) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@
  function Result([int]$code) {
    if ($code -eq 0) { return 'ok' }
    if ($code -eq 1168) { return 'missing' }
    if ($code -eq 5) { return 'denied' }
    if ($code -eq 1312) { return 'locked' }
    return 'unavailable'
  }
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $status = 'unavailable'
  $token = $null
  if ($request.action -eq 'write') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($request.token)
    $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      $credential = New-Object PaveGridCredential+Credential
      $credential.Type = 1; $credential.TargetName = $request.service
      $credential.UserName = 'pavegrid'; $credential.Persist = 2
      $credential.CredentialBlobSize = $bytes.Length; $credential.CredentialBlob = $blob
      $status = Result ([PaveGridCredential]::Write([ref]$credential, 0))
    } finally {
      for ($i=0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($blob, $i, 0) }
      [Array]::Clear($bytes, 0, $bytes.Length)
      [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    }
  } elseif ($request.action -eq 'read') {
    $ptr = [IntPtr]::Zero
    $status = Result ([PaveGridCredential]::Read($request.service, 1, 0, [ref]$ptr))
    if ($status -eq 'ok') {
      try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][PaveGridCredential+Credential])
        $bytes = New-Object byte[] $credential.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
        $token = [Text.Encoding]::UTF8.GetString($bytes)
        [Array]::Clear($bytes, 0, $bytes.Length)
      } finally { [PaveGridCredential]::Free($ptr) }
    }
  } elseif ($request.action -eq 'remove') {
    $status = Result ([PaveGridCredential]::Delete($request.service, 1, 0))
  }
  @{status=$status;token=$token} | ConvertTo-Json -Compress
} catch { [Console]::Out.Write('{"status":"unavailable"}') }
`;

export const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($req.action -eq 'secure') {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $req.path -AclObject $acl
  } elseif ($req.action -ne 'verify') {
    exit 1
  }
  $acl = Get-Acl -LiteralPath $req.path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { exit 1 }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -ne 1) { exit 1 }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None -or
      $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { exit 1 }
  exit 0
} catch { exit 1 }
`;
