#!/bin/sh
set -eu

gateway_url=${JARVIS_GATEWAY_URL:-http://127.0.0.1:3090}
timeout_seconds=${JARVIS_GATEWAY_TIMEOUT_SECONDS:-5}
health_file=$(mktemp "${TMPDIR:-/tmp}/jarvis-gateway-health.XXXXXX")

cleanup() {
  rm -f "$health_file"
}
trap cleanup EXIT HUP INT TERM

node --input-type=module - "$gateway_url" "$timeout_seconds" <<'NODE'
const [urlValue, timeoutValue] = process.argv.slice(2)
let gatewayUrl
try {
  gatewayUrl = new URL(urlValue)
} catch {
  console.error('Gateway URL is invalid')
  process.exit(2)
}
const timeout = Number(timeoutValue)
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
  console.error('Gateway timeout must be an integer from 1 to 30 seconds')
  process.exit(2)
}
if (gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash
  || (gatewayUrl.pathname !== '' && gatewayUrl.pathname !== '/')) {
  console.error('Gateway URL must not contain credentials, query, fragment, or a path')
  process.exit(2)
}
const host = gatewayUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '')
const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
if (!loopback && gatewayUrl.protocol !== 'https:') {
  console.error('Non-loopback Gateway URLs must use HTTPS')
  process.exit(2)
}
NODE

health_url="${gateway_url%/}/v1/health"
if ! curl --fail --silent --show-error --connect-timeout "$timeout_seconds" \
  --max-time "$timeout_seconds" --output "$health_file" "$health_url"; then
  echo 'Gateway health request failed' >&2
  exit 1
fi

node --input-type=module - "$health_file" "$gateway_url" <<'NODE'
import { readFileSync } from 'node:fs'

const [healthFile, urlValue] = process.argv.slice(2)
let payload
try {
  payload = JSON.parse(readFileSync(healthFile, 'utf8'))
} catch {
  console.error('Gateway health response is not valid JSON')
  process.exit(1)
}
const gatewayUrl = new URL(urlValue)
const host = gatewayUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '')
const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
const expectedScope = loopback ? 'loopback-only' : 'private-network'
const expectedTransport = gatewayUrl.protocol === 'https:' ? 'https' : 'http'
if (payload?.service !== 'jarvis-gateway' || payload.status !== 'ok'
  || payload.scope !== expectedScope || payload.transport !== expectedTransport) {
  console.error('Gateway health response does not match the configured private transport')
  process.exit(1)
}
console.log('Gateway health passed (' + payload.scope + ', ' + payload.transport + ')')
NODE
