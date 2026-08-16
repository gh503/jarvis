import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface AppDefinition {
  displayName: string
  macOSName: string
}

export class AppRegistry {
  private constructor(private readonly apps: Readonly<Record<string, AppDefinition>>) {}

  static async load(path: string): Promise<AppRegistry> {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('config/apps.json must contain an object')
    }
    const apps: Record<string, AppDefinition> = {}
    for (const [key, item] of Object.entries(value)) {
      if (!/^[a-z0-9-]+$/u.test(key) || typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`invalid application entry: ${key}`)
      }
      const displayName = Reflect.get(item, 'displayName')
      const macOSName = Reflect.get(item, 'macOSName')
      if (typeof displayName !== 'string' || typeof macOSName !== 'string' || displayName === '' || macOSName === '') {
        throw new Error(`invalid application definition: ${key}`)
      }
      apps[key] = { displayName, macOSName }
    }
    return new AppRegistry(Object.freeze(apps))
  }

  resolve(application: string): AppDefinition | undefined {
    return this.apps[application.trim().toLowerCase()]
  }

  keys(): string[] {
    return Object.keys(this.apps).sort()
  }

  async open(application: string, signal: AbortSignal): Promise<AppDefinition> {
    const definition = this.resolve(application)
    if (definition === undefined) throw new Error(`application is not allowlisted: ${application}`)
    await execFileAsync('/usr/bin/open', ['-a', definition.macOSName], { signal })
    return definition
  }
}
