import { WebSocket } from 'ws'
import type { HomeAssistantSocket, HomeAssistantSocketFactory } from './home-assistant.js'

export interface HomeAssistantRuntimeConfig {
  url: string
  accessToken: string
  commandTimeoutMs: number
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]
  if (value === undefined) return undefined
  if (value.length === 0) throw new Error(`${name} must not be empty`)
  return value
}

export function readHomeAssistantRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HomeAssistantRuntimeConfig | undefined {
  const url = requiredEnvironment(environment, 'JARVIS_HOME_ASSISTANT_URL')
  const accessToken = requiredEnvironment(environment, 'JARVIS_HOME_ASSISTANT_TOKEN')
  if (url === undefined && accessToken === undefined) return undefined
  if (url === undefined || accessToken === undefined) {
    throw new Error('JARVIS_HOME_ASSISTANT_URL and JARVIS_HOME_ASSISTANT_TOKEN must be configured together')
  }
  const commandTimeoutMs = environment.JARVIS_HOME_ASSISTANT_COMMAND_TIMEOUT_MS === undefined
    ? 10_000
    : Number(environment.JARVIS_HOME_ASSISTANT_COMMAND_TIMEOUT_MS)
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 120_000) {
    throw new Error('JARVIS_HOME_ASSISTANT_COMMAND_TIMEOUT_MS must be an integer from 1 to 120000')
  }
  return { url, accessToken, commandTimeoutMs }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  return String(value)
}

export function createHomeAssistantSocketFactory(): HomeAssistantSocketFactory {
  return (url: string): HomeAssistantSocket => {
    const socket = new WebSocket(url)
    return {
      addEventListener(type, listener) {
        if (type === 'message') {
          socket.on('message', data => listener({ data: messageText(data) }))
          return
        }
        socket.on(type, () => listener({ data: '' }))
      },
      send(data) {
        socket.send(data)
      },
      close() {
        socket.close()
      },
    }
  }
}
