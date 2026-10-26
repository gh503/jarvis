import { randomUUID } from 'node:crypto'

export interface JarvisEvent<T = unknown> {
  id: string
  type: string
  at: string
  data: T
}

type Listener = (event: JarvisEvent) => void

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly anyListeners = new Set<Listener>()
  private readonly ring: JarvisEvent[] = []

  constructor(private readonly capacity = 200) {}

  on(type: string, listener: Listener): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  onAny(listener: Listener): () => void {
    this.anyListeners.add(listener)
    return () => this.anyListeners.delete(listener)
  }

  emit<T>(type: string, data: T): JarvisEvent<T> {
    const event: JarvisEvent<T> = {
      id: randomUUID(),
      type,
      at: new Date().toISOString(),
      data,
    }
    this.ring.push(event)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)
    for (const listener of this.listeners.get(type) ?? []) {
      this.safe(listener, event)
    }
    for (const listener of this.anyListeners) {
      this.safe(listener, event)
    }
    return event
  }

  history(limit = 50): JarvisEvent[] {
    return this.ring.slice(-Math.max(1, Math.min(limit, this.capacity)))
  }

  private safe(listener: Listener, event: JarvisEvent): void {
    try {
      listener(event)
    } catch (error) {
      console.error('event listener failed', error)
    }
  }
}