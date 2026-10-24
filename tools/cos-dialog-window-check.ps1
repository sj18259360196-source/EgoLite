param([long]$OwnerHandle, [int]$ExpectedProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DialogCheck {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  $script:found = [IntPtr]::Zero
  [DialogCheck]::EnumWindows({ param($h,$p)
    [uint32]$process = 0
    [void][DialogCheck]::GetWindowThreadProcessId($h,[ref]$process)
    $name = [Text.StringBuilder]::new(256)
    [void][DialogCheck]::GetClassName($h,$name,256)
    if ($process -eq $ExpectedProcessId -and $name.ToString() -eq '#32770' -and [DialogCheck]::IsWindowVisible($h)) { $script:found=$h; return $false }
    return $true
  },[IntPtr]::Zero) | Out-Null
  if ($script:found -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($script:found -eq [IntPtr]::Zero) { throw 'Fixture dialog did not appear' }
Start-Sleep -Milliseconds 300
$parent = [DialogCheck]::GetWindow($script:found,4)
$matches = $false
for ($n=0; $n -lt 8 -and $parent -ne [IntPtr]::Zero; $n++) {
  if ($parent.ToInt64() -eq $OwnerHandle) { $matches=$true; break }
  $parent = [DialogCheck]::GetWindow($parent,4)
}
$front = [DialogCheck]::GetForegroundWindow() -eq $script:found
$activeTitle = [Text.StringBuilder]::new(256)
$dialogTitle = [Text.StringBuilder]::new(256)
[void][DialogCheck]::GetWindowText([DialogCheck]::GetForegroundWindow(),$activeTitle,256)
[void][DialogCheck]::GetWindowText($script:found,$dialogTitle,256)
[void][DialogCheck]::PostMessage($script:found,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
@{ ownerMatched=$matches; foreground=$front; dialogFound=$true; activeTitle=$activeTitle.ToString(); dialogTitle=$dialogTitle.ToString() } | ConvertTo-Json -Compress
