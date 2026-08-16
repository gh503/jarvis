import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'
import { decryptPairingCredential } from '../web/pairing.js'

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
    '/app/', '/app/app.css', '/app/app.js?v=4', '/app/pairing.js?v=4', '/app/apple-touch-icon.png', '/app/icon.svg',
    '/app/icon-192.png', '/app/icon-512.png', '/app/manifest.webmanifest',
  ]) {
    assert.ok(serviceWorker.includes(`'${path}'`), `${path} must be pre-cached`)
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
  const appSource = await readFile(join(webRoot, 'app.js'), 'utf8')
  const pairingSource = await readFile(join(webRoot, 'pairing.js'), 'utf8')
  const htmlSource = await readFile(join(webRoot, 'index.html'), 'utf8')
  assert.match(appSource, /fetch\('\.\.\/v1\/health'/)
  assert.match(appSource, /handlePairingState\(\{ phase: 'loading' \}\)/)
  assert.match(pairingSource, /indexedDB\.open/)
  assert.match(pairingSource, /await this\.initialize\(\)/)
  assert.match(htmlSource, /id="pair-button"[^>]+disabled/)
  assert.doesNotMatch(`${appSource}\n${pairingSource}`, /@deepseek-ai|dsh|Harness|\/api\//i)
  assert.doesNotMatch(`${appSource}\n${pairingSource}`, /localStorage|sessionStorage/)
})

test('decrypts the Gateway claim envelope with the browser claim secret', async () => {
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const identity = createDeviceIdentity()
  const challenge = authority.createClaimableRequest({
    nodeId: 'pwa-browser', publicKey: identity.publicKey, displayName: 'Browser', platform: 'pwa',
  })
  authority.approveClaimable(challenge.verificationCode)
  const claim = authority.claim(challenge.requestId, challenge.claimToken)
  const credential = await decryptPairingCredential(claim.encryptedCredential, challenge.claimToken)
  assert.equal(authority.authenticate('pwa-browser', credential), true)
})
