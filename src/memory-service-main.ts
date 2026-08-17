import { resolve } from 'node:path'
import { MemoryService } from './memory-service.js'

const dataDir = resolve(process.env.JARVIS_DATA_DIR ?? resolve(import.meta.dirname, '..', 'data'))
const portValue = Number(process.env.JARVIS_MEMORY_PORT ?? '0')
if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65_535) throw new Error('JARVIS_MEMORY_PORT is invalid')
const service = new MemoryService(dataDir)
await service.start(portValue)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void service.stop().finally(() => process.exit(0)) })
}
