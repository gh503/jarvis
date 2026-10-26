import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DeviceStore } from '../src/devices.ts'

test('device tokens are stored hashed and can be revoked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-devices-'))
  try {
    const file = join(dir, 'devices.json')
    const store = new DeviceStore(file)
    const issued = store.issue('phone')
    assert.equal(store.verify(issued.token), true)
    assert.equal(store.verify('wrong'), false)
    const raw = await (await import('node:fs/promises')).readFile(file, 'utf8')
    assert.doesNotMatch(raw, new RegExp(issued.token))
    assert.equal(store.revoke(issued.device.id), true)
    assert.equal(store.verify(issued.token), false)
    const reloaded = new DeviceStore(file)
    assert.equal(reloaded.verify(issued.token), false)
    assert.equal(reloaded.list()[0].revoked, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clear revokes every device and deletes the hashed store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-devices-clear-'))
  try {
    const file = join(dir, 'devices.json')
    const store = new DeviceStore(file)
    const issued = store.issue('tablet')
    store.clear()
    assert.equal(store.verify(issued.token), false)
    assert.deepEqual(store.list(), [])
    assert.equal((await import('node:fs')).existsSync(file), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
