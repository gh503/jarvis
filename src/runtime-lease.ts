import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

interface LeaseOwner {
  version: 1
  pid: number
  role: string
  createdAt: string
}

export interface RuntimeLease {
  readonly path: string
  release(): Promise<void>
}

const MAINTENANCE_DIRECTORY = 'maintenance.lock'
const OWNER_FILE = 'owner.json'

function owner(pid: number, role: string): LeaseOwner {
  return { version: 1, pid, role, createdAt: new Date().toISOString() }
}

function parseOwner(value: unknown): LeaseOwner {
  if (typeof value !== 'object' || value === null) throw new Error('lease owner must be an object')
  const version = Reflect.get(value, 'version')
  const pid = Reflect.get(value, 'pid')
  const role = Reflect.get(value, 'role')
  const createdAt = Reflect.get(value, 'createdAt')
  if (version !== 1 || !Number.isSafeInteger(pid) || (pid as number) < 1
    || typeof role !== 'string' || role.length < 1 || role.length > 80
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('lease owner is malformed')
  }
  return value as LeaseOwner
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    return true
  }
}

async function writeOwner(path: string, value: LeaseOwner): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

async function readOwner(path: string): Promise<LeaseOwner> {
  return parseOwner(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

async function ensureRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function maintenanceOwner(runtimeDir: string): Promise<LeaseOwner | undefined> {
  const path = join(runtimeDir, MAINTENANCE_DIRECTORY, OWNER_FILE)
  try {
    return await readOwner(path)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error(`cannot validate maintenance lease: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function reclaimStaleMaintenance(runtimeDir: string): Promise<void> {
  const lockPath = join(runtimeDir, MAINTENANCE_DIRECTORY)
  const current = await maintenanceOwner(runtimeDir)
  if (current === undefined) {
    try {
      await readdir(lockPath)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    throw new Error('maintenance lease exists without a valid owner; remove it manually after verifying Jarvis is stopped')
  }
  if (processIsAlive(current.pid)) return
  await rm(lockPath, { recursive: true, force: true })
}

async function activeRuntimeLeases(runtimeDir: string): Promise<LeaseOwner[]> {
  const active: LeaseOwner[] = []
  for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('runtime-') || !entry.name.endsWith('.json')) continue
    const path = join(runtimeDir, entry.name)
    let current: LeaseOwner
    try {
      current = await readOwner(path)
    } catch (error: unknown) {
      throw new Error(`cannot validate runtime lease ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (processIsAlive(current.pid)) active.push(current)
    else await rm(path, { force: true })
  }
  return active
}

export async function acquireRuntimeLease(runtimeDir: string, role: string): Promise<RuntimeLease> {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(role)) throw new Error('runtime lease role is invalid')
  await ensureRuntimeDirectory(runtimeDir)
  await reclaimStaleMaintenance(runtimeDir)
  const existing = await maintenanceOwner(runtimeDir)
  if (existing !== undefined) throw new Error(`Jarvis maintenance is active (${existing.role})`)

  const path = join(runtimeDir, `runtime-${role}-${process.pid}-${randomUUID()}.json`)
  await writeOwner(path, owner(process.pid, role))
  const maintenance = await maintenanceOwner(runtimeDir)
  if (maintenance !== undefined) {
    await rm(path, { force: true })
    throw new Error(`Jarvis maintenance started while ${role} was launching`)
  }

  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      await rm(path, { force: true })
    },
  }
}

export async function acquireMaintenanceLease(runtimeDir: string, role: string): Promise<RuntimeLease> {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(role)) throw new Error('maintenance lease role is invalid')
  await ensureRuntimeDirectory(runtimeDir)
  await reclaimStaleMaintenance(runtimeDir)
  const lockPath = join(runtimeDir, MAINTENANCE_DIRECTORY)
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const current = await maintenanceOwner(runtimeDir)
      throw new Error(`Jarvis maintenance is already active${current === undefined ? '' : ` (${current.role})`}`)
    }
    throw error
  }

  try {
    await writeOwner(join(lockPath, OWNER_FILE), owner(process.pid, role))
    const active = await activeRuntimeLeases(runtimeDir)
    if (active.length > 0) {
      const roles = [...new Set(active.map(item => item.role))].sort().join(', ')
      throw new Error(`stop Jarvis before ${role}; active runtime roles: ${roles}`)
    }
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }

  let released = false
  return {
    path: lockPath,
    async release() {
      if (released) return
      released = true
      await rm(lockPath, { recursive: true, force: true })
    },
  }
}
