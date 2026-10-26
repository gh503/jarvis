/* Visual tuning + the ambient particle field.
   The values come from the server's tuning store so the phone, desktop and
   browser preview all agree. Nothing security-sensitive is handled here. */

const DEFAULTS = {
  'ui.orbGlow': 0.9,
  'ui.orbSpeed': 1,
  'ui.particles': 18,
  'ui.ambient': 0.55,
  'ui.blur': 14,
  'ui.accentHue': 168,
  'ui.textScale': 1,
  'ui.motion': 'full',
  'ui.density': 'comfortable',
  'ui.graphLabels': true,
}

export let visualValues = { ...DEFAULTS }

export function applyVisualTuning(values = {}) {
  visualValues = { ...DEFAULTS, ...values }
  const root = document.documentElement
  const style = root.style
  style.setProperty('--orb-glow', String(visualValues['ui.orbGlow']))
  style.setProperty('--orb-speed', String(visualValues['ui.orbSpeed']))
  style.setProperty('--ambient-strength', String(visualValues['ui.ambient']))
  style.setProperty('--glass-blur', `${visualValues['ui.blur']}px`)
  style.setProperty('--accent-h', String(visualValues['ui.accentHue']))
  style.setProperty('--ui-text-scale', String(visualValues['ui.textScale']))
  style.setProperty('--ui-inverse-scale', String(1 / (Number(visualValues['ui.textScale']) || 1)))
  root.dataset.motion = String(visualValues['ui.motion'])
  root.dataset.density = String(visualValues['ui.density'])
  root.classList.toggle('motion-off', visualValues['ui.motion'] === 'off')
  document.body.style.zoom = Number(visualValues['ui.textScale']) === 1 ? '' : String(visualValues['ui.textScale'])
  startParticleField()
}

export async function loadVisualTuning(fetcher = fetch) {
  try {
    const token = localStorage.getItem('jarvis_token') || ''
    const response = await fetcher('/api/tuning', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok) return visualValues
    const data = await response.json()
    applyVisualTuning(data.values || {})
  } catch {
    applyVisualTuning(visualValues)
  }
  return visualValues
}

let particleState = null
let particleRaf = 0
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')

function particleCount() {
  if (reducedMotion?.matches) return 0
  const motion = visualValues['ui.motion']
  if (motion === 'off') return 0
  const base = Number(visualValues['ui.particles']) || 0
  return motion === 'subtle' ? Math.min(18, Math.round(base * 0.45)) : Math.min(60, Math.round(base))
}

export function startParticleField() {
  if (typeof document === 'undefined') return
  const canvas = document.getElementById('particle-field')
  if (!canvas) return
  if (!particleState) {
    particleState = { canvas, ctx: canvas.getContext('2d'), points: [], w: 0, h: 0, last: 0 }
    window.addEventListener('resize', resizeParticles, { passive: true })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelAnimationFrame(particleRaf)
      else particleRaf = requestAnimationFrame(tickParticles)
    })
    resizeParticles()
    particleRaf = requestAnimationFrame(tickParticles)
    return
  }
  syncParticles()
}

function resizeParticles() {
  if (!particleState) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  particleState.w = window.innerWidth
  particleState.h = window.innerHeight
  particleState.canvas.width = Math.round(particleState.w * dpr)
  particleState.canvas.height = Math.round(particleState.h * dpr)
  particleState.canvas.style.width = `${particleState.w}px`
  particleState.canvas.style.height = `${particleState.h}px`
  particleState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  syncParticles()
}

function syncParticles() {
  if (!particleState) return
  const count = particleCount()
  const points = particleState.points
  while (points.length < count) {
    points.push({
      x: Math.random() * particleState.w,
      y: Math.random() * particleState.h,
      vx: (Math.random() - 0.5) * 0.09,
      vy: (Math.random() - 0.5) * 0.09,
      r: 0.6 + Math.random() * 1.8,
      tone: Math.random() > 0.78 ? 'amber' : 'cyan',
    })
  }
  if (points.length > count) points.length = count
}

function tickParticles(now) {
  if (!particleState) return
  const { canvas, ctx, points, w, h } = particleState
  if (document.hidden || !canvas.isConnected) return
  const speed = Number(visualValues['ui.orbSpeed']) || 1
  ctx.clearRect(0, 0, w, h)
  const accent = `hsl(${Number(visualValues['ui.accentHue']) || 168} 63% 70%)`
  for (const point of points) {
    point.x += point.vx * speed
    point.y += point.vy * speed
    if (point.x < -10) point.x = w + 10
    if (point.x > w + 10) point.x = -10
    if (point.y < -10) point.y = h + 10
    if (point.y > h + 10) point.y = -10
  }
  ctx.lineWidth = 0.6
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i]
      const b = points[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distance = Math.hypot(dx, dy)
      if (distance > 110) continue
      ctx.globalAlpha = (1 - distance / 110) * 0.13
      ctx.strokeStyle = accent
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
  for (const point of points) {
    ctx.globalAlpha = point.tone === 'amber' ? 0.5 : 0.42
    ctx.fillStyle = point.tone === 'amber' ? '#f3b36a' : accent
    ctx.beginPath()
    ctx.arc(point.x, point.y, point.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  particleRaf = requestAnimationFrame(tickParticles)
}
