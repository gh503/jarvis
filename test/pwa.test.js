import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const webRoot = join(process.cwd(), 'web')

test('declares a scoped installable manifest and complete offline shell', async () => {
  const manifest = JSON.parse(await readFile(join(webRoot, 'manifest.webmanifest'), 'utf8'))
  assert.equal(manifest.id, '/app/')
  assert.equal(manifest.start_url, '/app/')
  assert.equal(manifest.scope, '/app/')
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.name)
  assert.ok(manifest.short_name)
  assert.ok(manifest.theme_color)
  assert.ok(manifest.background_color)
  assert.ok(manifest.icons.some(icon => icon.src === '/app/icon-192.png' && icon.sizes === '192x192'))
  assert.ok(manifest.icons.some(icon => icon.src === '/app/icon-512.png' && icon.sizes === '512x512'))

  const serviceWorker = await readFile(join(webRoot, 'sw.js'), 'utf8')
  for (const path of [
    '/app/', '/app/app.css', '/app/app.js', '/app/apple-touch-icon.png', '/app/icon.svg',
    '/app/icon-192.png', '/app/icon-512.png', '/app/manifest.webmanifest',
  ]) {
    assert.match(serviceWorker, new RegExp(`['"]${path.replaceAll('/', '\\/')}['"]`))
  }
  assert.match(serviceWorker, /event\.request\.mode === 'navigate'/)
  assert.match(serviceWorker, /caches\.match\('\/app\/'\)/)
})

test('ships valid standard and Apple PNG icon dimensions', async () => {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const icon = await readFile(join(webRoot, file))
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(icon.readUInt32BE(16), size)
    assert.equal(icon.readUInt32BE(20), size)
  }
})

test('keeps the browser client on the public Gateway contract', async () => {
  const source = await readFile(join(webRoot, 'app.js'), 'utf8')
  assert.match(source, /fetch\('\.\.\/v1\/health'/)
  assert.doesNotMatch(source, /@deepseek-ai|dsh|Harness|\/api\//i)
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/)
})
