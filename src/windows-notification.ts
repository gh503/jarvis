import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const WINDOWS_AUMID = 'org.jarvis.portable'

// PROPVARIANT is 24 bytes on x64 and at least 16 on x86; the LPWSTR field is
// always at offset 8. These interfaces preserve the native IPropertyStore order.
export const PROPERTY_STORE_TYPES = `
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct JarvisPropertyKey {
  public Guid format;
  public uint id;
  public static JarvisPropertyKey AppId() { return new JarvisPropertyKey { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = 5 }; }
}
[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct JarvisPropVariant {
  [FieldOffset(0)] public ushort type;
  [FieldOffset(8)] public IntPtr pointer;
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface JarvisPropertyStore {
  void GetCount(out uint count);
  void GetAt(uint index, out JarvisPropertyKey key);
  void GetValue(ref JarvisPropertyKey key, out JarvisPropVariant value);
  void SetValue(ref JarvisPropertyKey key, ref JarvisPropVariant value);
  void Commit();
}
public static class JarvisIdentity {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref JarvisPropVariant value);
  public static void Set(object instance) {
    var key = JarvisPropertyKey.AppId();
    var value = new JarvisPropVariant { type = 31, pointer = Marshal.StringToCoTaskMemUni("${WINDOWS_AUMID}") };
    try { var store = (JarvisPropertyStore)instance; store.SetValue(ref key, ref value); store.Commit(); }
    finally { PropVariantClear(ref value); }
  }
  public static string Read(object instance) {
    var key = JarvisPropertyKey.AppId();
    JarvisPropVariant value;
    ((JarvisPropertyStore)instance).GetValue(ref key, out value);
    try { return value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : null; }
    finally { PropVariantClear(ref value); }
  }
}
`

/** Bounded valid XML 1.0 text, counting Unicode scalar values, never splitting pairs. */
export function toastText(value: string, limit: number): string {
  let output = '', count = 0
  for (const char of value) {
    const point = char.codePointAt(0)!
    if (point < 32 && ![9, 10, 13].includes(point) || point >= 0xd800 && point <= 0xdfff || point === 0xfffe || point === 0xffff) continue
    if (count++ >= limit) break
    output += char
  }
  return output
}

export interface WindowsNotificationAvailability { available: boolean; command?: string; shortcut?: string; reason: string }
/** Discovery never runs PowerShell, registers identity, or sends a toast. */
export function windowsNotificationAvailability(env: NodeJS.ProcessEnv = process.env): WindowsNotificationAvailability {
  try {
    if (!env.SystemRoot || !env.APPDATA || !env.LOCALAPPDATA || ![env.SystemRoot, env.APPDATA, env.LOCALAPPDATA].every(isAbsolute)) throw new Error()
    const command = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const shortcut = join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Jarvis.lnk')
    const state = join(env.LOCALAPPDATA, 'Jarvis', 'native-install.json')
    for (const file of [command, shortcut, state]) {
      const info = lstatSync(file)
      if (!info.isFile() || file === state && info.size > 65536 || file === shortcut && info.size > 1048576) throw new Error()
      let current = resolve(file)
      while (true) {
        if (lstatSync(current).isSymbolicLink()) throw new Error()
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    const receipt = JSON.parse(readFileSync(state, 'utf8'))
    const entry = Array.isArray(receipt.files) ? receipt.files.find((item: { path?: string }) => item.path === shortcut) : undefined
    if (receipt.schemaVersion !== 1 || receipt.platform !== 'win32' || receipt.notificationAumid !== WINDOWS_AUMID || !entry || entry.sha256 !== createHash('sha256').update(readFileSync(shortcut)).digest('hex')) throw new Error()
    return { available: true, command, shortcut, reason: 'owned shortcut and PowerShell discovered; readiness=unknown; permission=unknown (notification not sent)' }
  } catch {
    return { available: false, reason: 'Windows toast requires PowerShell and an unchanged Jarvis shortcut from explicit native installation' }
  }
}

// This exact fragment is exercised by native XML serialization tests. User text
// is never parsed as XML or PowerShell. No launch argument, activation or actions.
export const POWERSHELL_TOAST_XML = `
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$texts = $xml.GetElementsByTagName('text')
[void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:JARVIS_TOAST_TITLE))
[void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:JARVIS_TOAST_BODY))
`
export const POWERSHELL_TOAST_TYPES = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
`
export const POWERSHELL_TOAST = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = $PSHOME + '\\Modules'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
${PROPERTY_STORE_TYPES}
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class JarvisToastLink {}
public static class JarvisToastIdentity {
  public static bool Check(string path) {
    object instance = new JarvisToastLink();
    try { ((IPersistFile)instance).Load(path, 0); return JarvisIdentity.Read(instance) == "${WINDOWS_AUMID}"; }
    finally { Marshal.FinalReleaseComObject(instance); }
  }
}
'@
if (![JarvisToastIdentity]::Check($env:JARVIS_TOAST_SHORTCUT)) { exit 2 }
${POWERSHELL_TOAST_XML}
${POWERSHELL_TOAST_TYPES}
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_AUMID}')
if ($notifier.Setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) { exit 3 }
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier.Show($toast)
} catch { exit 1 }
`
