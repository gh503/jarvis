/**
 * What this machine can actually do.
 *
 * Jarvis started as a Linux-only desktop assistant: screen capture goes through
 * the GNOME portal helper, the camera is read from /dev/video0, notifications
 * use notify-send and autostart is a systemd user unit. On macOS and Windows the
 * core server runs natively. Scoped external filesystem and sandbox capabilities
 * must be reported separately; an OS label is never proof of feature readiness.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { scopedFilesystemCapability } from './local-tools/scoped-filesystem.ts'
import { windowsNotificationAvailability } from './windows-notification.ts'

export type PlatformOs = 'linux' | 'darwin' | 'win32' | 'other'

export interface Capabilities {
  os: PlatformOs
  /** Human label for the UI ("Linux" / "macOS" / "Windows"). */
  label: string
  screenCapture: boolean
  camera: boolean
  localAsr: boolean
  localTts: boolean
  notify: boolean
  autostart: boolean
  /** Reasons distinguish support, discovery and unverified readiness/permissions.
   * False may mean unverified, not unsupported; runtime health can refine it.
   */
  reasons: Record<string, string>
}

function commandExists(name: string): boolean {
  const paths = isAbsolute(name) || /[\\/]/.test(name) ? [name]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ''), name))
  const exts = process.platform === 'win32' ? ['', '.exe', '.com'] : ['']
  for (const path of paths) {
    for (const ext of exts) {
      try {
        if (!statSync(path + ext).isFile()) continue
        accessSync(path + ext, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return true
      } catch {
        // An unreadable PATH entry is simply not a match.
      }
    }
  }
  return false
}

export function platformOs(): PlatformOs {
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'other'
}

export function capabilities(rootDir: string): Capabilities {
  const os = platformOs()
  const label = os === 'linux' ? 'Linux' : os === 'darwin' ? 'macOS' : os === 'win32' ? 'Windows' : os
  const screenHelper = existsSync(join(rootDir, 'scripts', 'screen_capture.py'))
  const cameraDevice = existsSync('/dev/video0')
  // No model loads, capture requests, or permission prompts during discovery.

  const reasons: Record<string, string> = {}
  // UI availability hints permit explicit user-triggered probes; reasons never
  // claim that discovery establishes permission or runtime readiness.
  const screenCapture = os === 'linux' && screenHelper && commandExists('python3')
  reasons.screenCapture = `supported=${os === 'linux'}; installed=${os === 'linux' && screenHelper && commandExists('python3')}; configured=unknown; readiness=unknown; permission=unknown (portal/session not probed)`

  const camera = os === 'linux' && cameraDevice
  reasons.camera = `supported=${os === 'linux'}; installed=${os === 'linux' && cameraDevice}; configured=unknown; readiness=unknown; permission=unknown (device not opened)`

  const localAsr = false
  reasons.localAsr = 'supported=true; installed=unknown; configured=unknown; readiness=unknown (Python and worker presence do not verify ASR dependencies or model); permission=unknown'

  const localTts = false
  reasons.localTts = 'supported=true; installed=unknown; configured=unknown; readiness=unknown (configured engine and voice not probed); permission=unknown'

  const windowsNotify = os === 'win32' ? windowsNotificationAvailability() : undefined
  const notify = os === 'linux' ? commandExists('notify-send') : os === 'darwin' ? commandExists('/usr/bin/osascript') : !!windowsNotify?.available
  reasons.notify = `supported=${os === 'linux' || os === 'darwin' || os === 'win32'}; installed=${notify}; configured=${windowsNotify ? windowsNotify.available : 'unknown'}; readiness=unknown; permission=unknown (notification not sent)${windowsNotify ? `; ${windowsNotify.reason}` : ''}`

  const autostart = os === 'linux' ? commandExists('systemctl') : os === 'darwin' || os === 'win32'
  reasons.autostart = `supported=${os === 'linux' || os === 'darwin' || os === 'win32'}; installed=${autostart}; configured=unknown; readiness=unknown; permission=unknown (${os === 'linux' ? 'user service not queried' : 'explicit native installation with --autostart required; login launch not verified'})`
  const scoped = scopedFilesystemCapability()
  reasons.scopedFilesystem = `supported=${scoped.supported}; readiness=unknown; permission=unknown; ${scoped.reason ?? 'Linux descriptor-relative backend; configured roots and /proc access not probed'}`

  return { os, label, screenCapture, camera, localAsr, localTts, notify, autostart, reasons }
}
