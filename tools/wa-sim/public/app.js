// Customer phone page for wa-sim. All text coming from wacrm is rendered with
// textContent (never innerHTML) so a message can't inject markup.

const $ = (id) => document.getElementById(id)
const POLL_MS = 2000

let selected = null
let lastRenderKey = ''

async function api(path, options = {}) {
  const res = await fetch(`/ui/api/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok && res.status !== 502) throw new Error(data.error || `Error ${res.status}`)
  return data
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) if (child) node.append(child)
  return node
}

const time = (iso) =>
  new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })

// ---------- sidebar ----------

function renderCustomers(customers) {
  const list = $('customer-list')
  list.replaceChildren(
    ...customers.map((c) =>
      el('li', {}, [
        el(
          'button',
          {
            type: 'button',
            'aria-current': c.waId === selected ? 'true' : 'false',
            onclick: () => openChat(c.waId),
          },
          [
            el('span', { class: 'name', text: c.name }),
            c.unread > 0 && c.waId !== selected ? el('span', { class: 'badge', text: String(c.unread) }) : el('span'),
            el('span', { class: 'preview', text: c.lastPreview || `+${c.waId}` }),
          ],
        ),
      ]),
    ),
  )
}

$('new-customer').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  $('new-customer-error').textContent = ''
  try {
    const customer = await api('customers', {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.namedItem('name').value,
        waId: form.elements.namedItem('waId').value,
      }),
    })
    form.reset()
    await openChat(customer.waId)
  } catch (err) {
    $('new-customer-error').textContent = err.message
  }
})

// ---------- conversation ----------

async function sendInbound(body) {
  if (!selected) return
  const result = await api(`customers/${selected}/messages`, { method: 'POST', body: JSON.stringify(body) })
  showDelivery(result.delivery)
  await refreshMessages(true)
}

function showDelivery(delivery) {
  const banner = $('webhook-banner')
  if (!delivery || delivery.ok) {
    banner.hidden = true
    return
  }
  banner.hidden = false
  banner.textContent = `wacrm no aceptó el webhook (${delivery.status || 'sin respuesta'}). ${delivery.error || ''}`
}

function replyButton(label, onclick) {
  return el('button', { type: 'button', class: 'btn', text: label, onclick })
}

function renderBusinessMessage(m) {
  const children = []
  const c = m.content ?? {}

  if (m.type === 'text') {
    children.push(el('span', { text: c.body ?? '' }))
  } else if (m.type === 'template') {
    const r = m.rendered ?? {}
    children.push(el('span', { class: 'tag', text: r.known ? 'Plantilla' : 'Plantilla (no registrada en el simulador)' }))
    if (r.header?.format === 'TEXT' && r.header.text) children.push(el('p', { class: 'header', text: r.header.text }))
    if (r.header?.format === 'IMAGE' && r.header.link) children.push(el('img', { src: r.header.link, alt: '' }))
    children.push(el('span', { text: r.body ?? '' }))
    if (r.footer) children.push(el('p', { class: 'footer', text: r.footer }))
    const buttons = (r.buttons ?? []).map((b) => {
      if (b.type === 'QUICK_REPLY') {
        return replyButton(b.text, () => sendInbound({ quickReply: { payload: b.payload, text: b.text }, contextId: m.id }))
      }
      if (b.type === 'URL' && b.url) {
        return el('a', { class: 'btn', href: b.url, target: '_blank', rel: 'noopener noreferrer', text: b.text })
      }
      return el('button', { type: 'button', class: 'btn', disabled: 'disabled', text: b.text })
    })
    if (buttons.length) children.push(el('div', { class: 'actions' }, buttons))
  } else if (m.type === 'interactive') {
    if (c.header?.text) children.push(el('p', { class: 'header', text: c.header.text }))
    children.push(el('span', { text: c.body?.text ?? '' }))
    if (c.footer?.text) children.push(el('p', { class: 'footer', text: c.footer.text }))
    if (c.type === 'button') {
      const buttons = (c.action?.buttons ?? []).map((b) =>
        replyButton(b.reply?.title ?? '', () =>
          sendInbound({ reply: { kind: 'button_reply', id: b.reply?.id, title: b.reply?.title }, contextId: m.id }),
        ),
      )
      children.push(el('div', { class: 'actions' }, buttons))
    } else if (c.type === 'list') {
      children.push(
        el('div', { class: 'actions' }, [replyButton(c.action?.button || 'Ver opciones', () => openList(m))]),
      )
    }
  } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)) {
    if (m.type === 'image' && c.link) children.push(el('img', { src: c.link, alt: c.caption ?? '' }))
    else if (c.link) children.push(el('a', { href: c.link, target: '_blank', rel: 'noopener noreferrer', text: c.filename || `[${m.type}]` }))
    if (c.caption) children.push(el('span', { text: c.caption }))
  } else {
    children.push(el('span', { class: 'tag', text: `[${m.type}]` }))
  }
  if (m.reaction) children.push(el('span', { class: 'tag', text: `Reacción: ${m.reaction}` }))
  return children
}

function openList(m) {
  const c = m.content
  $('list-title').textContent = c.action?.button || 'Opciones'
  $('list-sections').replaceChildren(
    ...(c.action?.sections ?? []).map((section) =>
      el('div', { class: 'list-section' }, [
        section.title ? el('h3', { text: section.title }) : null,
        ...(section.rows ?? []).map((row) =>
          el(
            'button',
            {
              type: 'button',
              class: 'btn list-row',
              onclick: () => {
                $('list-dialog').close()
                sendInbound({
                  reply: { kind: 'list_reply', id: row.id, title: row.title, description: row.description },
                  contextId: m.id,
                })
              },
            },
            [el('span', { text: row.title }), row.description ? el('small', { text: row.description }) : null],
          ),
        ),
      ]),
    ),
  )
  $('list-dialog').showModal()
}

function renderMessages(messages) {
  const key = JSON.stringify(messages.map((m) => [m.id, m.status, m.reaction]))
  if (key === lastRenderKey) return
  lastRenderKey = key
  const list = $('messages')
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60
  list.replaceChildren(
    ...messages.map((m) => {
      const isIn = m.direction === 'in'
      const body = isIn
        ? [
            m.replyTitle ? el('span', { class: 'tag', text: 'Respuesta' }) : null,
            el('span', { text: m.text ?? m.replyTitle ?? '' }),
          ]
        : renderBusinessMessage(m)
      return el('li', { class: `msg ${isIn ? 'in' : 'out'}` }, [...body, el('span', { class: 'meta', text: time(m.createdAt) })])
    }),
  )
  if (atBottom) list.scrollTop = list.scrollHeight
}

async function refreshMessages(forceScroll = false) {
  if (!selected) return
  const data = await api(`customers/${selected}/messages`)
  $('chat-name').textContent = data.customer.name
  $('chat-number').textContent = `+${data.customer.waId}`
  renderMessages(data.messages)
  if (forceScroll) $('messages').scrollTop = $('messages').scrollHeight
}

async function openChat(waId) {
  selected = waId
  lastRenderKey = ''
  $('empty').hidden = true
  $('conversation').hidden = false
  document.querySelector('.app').classList.add('chat-open')
  await refreshMessages(true)
  await refreshState()
  $('composer-text').focus()
}

$('back').addEventListener('click', () => {
  selected = null
  document.querySelector('.app').classList.remove('chat-open')
  $('conversation').hidden = true
  $('empty').hidden = false
  refreshState()
})

$('delete-chat').addEventListener('click', async () => {
  if (!selected || !confirm('¿Borrar este cliente y su chat del simulador? (En wacrm no se borra nada.)')) return
  await api(`customers/${selected}`, { method: 'DELETE' })
  $('back').click()
})

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault()
  const box = $('composer-text')
  const text = box.value.trim()
  if (!text) return
  box.value = ''
  await sendInbound({ text })
})

$('composer-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    $('composer').requestSubmit()
  }
})

// ---------- polling ----------

async function refreshState() {
  const data = await api('state')
  $('business-line').textContent = `${data.business.name} · ${data.business.phone}`
  renderCustomers(data.customers)
}

async function tick() {
  try {
    await refreshState()
    await refreshMessages()
  } catch (err) {
    console.error(err)
  } finally {
    setTimeout(tick, POLL_MS)
  }
}

tick()
