/**
 * What this machine can actually do.
 *
 * Jarvis started as a Linux-only desktop assistant: screen capture goes through
 * the GNOME portal helper, the camera is read from /dev/video0, notifications
 * use notify-send and autostart is a systemd user unit. On macOS and Windows the
 * server still runs — chat, memory, reminders, files and remote providers all
 * work — but those four features are unavailable, and the UI must say so
 * instead of failing silently.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
  /** Reasons keyed by capability name, shown in tooltips. */
  reasons: Record<string, string>
}

function commandExists(name: string): boolean {
  const path = process.env.PATH ?? ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, `${name}${ext}`))) return true
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
  const python = commandExists('python3') || commandExists('python')
  const asrWorker = existsSync(join(rootDir, 'scripts', 'asr_worker.py'))
  const piper = commandExists('piper')
  const edgeTts = commandExists('edge-tts')

  const reasons: Record<string, string> = {}
  const screenCapture = os === 'linux' && screenHelper && commandExists('python3')
  if (!screenCapture) reasons.screenCapture = os === 'linux' ? '缺少屏幕捕获辅助脚本或 Python' : '屏幕捕获目前只支持 Linux（需要 xdg-desktop-portal）'

  const camera = os === 'linux' && cameraDevice
  if (!camera) reasons.camera = os === 'linux' ? '没有找到 /dev/video0' : '摄像头捕获目前只支持 Linux'

  const localAsr = python && asrWorker
  if (!localAsr) reasons.localAsr = python ? '缺少 scripts/asr_worker.py' : '需要 Python 3 与 faster-whisper'

  const localTts = piper || edgeTts
  if (!localTts) reasons.localTts = '需要 piper 或 edge-tts'

  const notify = os === 'linux' && commandExists('notify-send')
  if (!notify) reasons.notify = os === 'linux' ? '缺少 notify-send' : '桌面通知目前只支持 Linux'

  const autostart = os === 'linux' && commandExists('systemctl')
  if (!autostart) reasons.autostart = '开机自启目前只支持 Linux（systemd --user）'

  return { os, label, screenCapture, camera, localAsr, localTts, notify, autostart, reasons }
}
