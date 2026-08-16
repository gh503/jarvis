import { arch, freemem, hostname, loadavg, platform, release, totalmem, uptime } from 'node:os'

export interface SystemStatus {
  hostname: string
  platform: string
  release: string
  architecture: string
  uptimeMinutes: number
  totalMemoryGB: number
  freeMemoryGB: number
  loadAverage: number[]
}

export function readSystemStatus(): SystemStatus {
  const gigabyte = 1024 ** 3
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    architecture: arch(),
    uptimeMinutes: Math.round(uptime() / 60),
    totalMemoryGB: Number((totalmem() / gigabyte).toFixed(2)),
    freeMemoryGB: Number((freemem() / gigabyte).toFixed(2)),
    loadAverage: loadavg().map(value => Number(value.toFixed(2))),
  }
}
