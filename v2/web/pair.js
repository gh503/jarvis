const $ = selector => document.querySelector(selector)
const form = $('#pair-form')
const status = $('#pair-status')

form.addEventListener('submit', async event => {
  event.preventDefault()
  const code = $('#pair-code').value.replace(/\D/g, '')
  const name = $('#pair-name').value.trim()
  if (code.length !== 6) {
    status.textContent = '请输入六位配对码。'
    status.className = 'pair-status error'
    return
  }
  const button = form.querySelector('button')
  button.disabled = true
  status.textContent = '正在配对…'
  status.className = 'pair-status'
  try {
    const response = await fetch('/api/devices/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `配对失败（${response.status}）`)
    status.textContent = '配对成功，正在进入…'
    location.replace('/')
  } catch (error) {
    status.textContent = error.message
    status.className = 'pair-status error'
    button.disabled = false
  }
})

$('#pair-code').addEventListener('input', event => {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6)
})
