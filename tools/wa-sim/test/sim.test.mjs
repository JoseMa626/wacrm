import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { loadConfig } from '../src/config.mjs'
import { createStore } from '../src/store.mjs'
import { buildInboundPayload, buildStatusPayload, sign } from '../src/webhook.mjs'
import { renderTemplate, fillPlaceholders } from '../src/templates.mjs'
import { handleGraph } from '../src/graph.mjs'
import { createApp } from '../src/server.mjs'

function setup() {
  const config = loadConfig({
    SIM_ACCESS_TOKEN: 'tok',
    SIM_APP_SECRET: 'secret',
    WACRM_WEBHOOK_URL: 'http://wacrm.test/api/whatsapp/webhook',
    SIM_UI_USER: 'u',
    SIM_UI_PASSWORD: 'p',
    SIM_SENT_DELAY_MS: '5',
    SIM_DELIVERED_DELAY_MS: '10',
  })
  const store = createStore(mkdtempSync(join(tmpdir(), 'wa-sim-')))
  const delivered = []
  const fetchImpl = async (url, init) => {
    delivered.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return new Response('OK', { status: 200 })
  }
  const ctx = { config, store, baseUrl: 'https://sim.test', fetchImpl }
  return { config, store, delivered, fetchImpl, ctx }
}

const graph = (ctx, method, path, body, version = 'v21.0') => {
  const url = new URL(`http://x/${path}`)
  return handleGraph(ctx, {
    method,
    version,
    segments: url.pathname.split('/').filter(Boolean),
    query: url.searchParams,
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  })
}

test('signature matches HMAC-SHA256 of the raw body, as Meta does', () => {
  const raw = '{"a":1}'
  const expected = `sha256=${createHmac('sha256', 'secret').update(raw).digest('hex')}`
  assert.equal(sign(raw, 'secret'), expected)
})

test('inbound text payload has Meta envelope and phone_number_id', () => {
  const { config } = setup()
  const { message, payload } = buildInboundPayload(config, { waId: '5215512345678', name: 'Ana' }, { text: 'Hola' })
  const value = payload.entry[0].changes[0].value
  assert.equal(payload.object, 'whatsapp_business_account')
  assert.equal(value.metadata.phone_number_id, config.phoneNumberId)
  assert.deepEqual(value.contacts[0], { profile: { name: 'Ana' }, wa_id: '5215512345678' })
  assert.equal(message.type, 'text')
  assert.equal(message.text.body, 'Hola')
})

test('button and list replies carry ids and context', () => {
  const { config } = setup()
  const customer = { waId: '5215512345678', name: 'Ana' }
  const b = buildInboundPayload(config, customer, { reply: { kind: 'button_reply', id: 'b1', title: 'Info' } }, 'wamid.X')
  assert.deepEqual(b.message.interactive, { type: 'button_reply', button_reply: { id: 'b1', title: 'Info' } })
  assert.equal(b.message.context.id, 'wamid.X')
  const l = buildInboundPayload(config, customer, { reply: { kind: 'list_reply', id: 'r1', title: 'Fila' } })
  assert.equal(l.message.interactive.list_reply.id, 'r1')
  const q = buildInboundPayload(config, customer, { quickReply: { payload: 'P', text: 'Sí' } })
  assert.deepEqual(q.message.button, { payload: 'P', text: 'Sí' })
})

test('status payload', () => {
  const { config } = setup()
  const p = buildStatusPayload(config, 'wamid.A', '521', 'delivered')
  assert.deepEqual(p.entry[0].changes[0].value.statuses[0].status, 'delivered')
})

test('template placeholders: positional and named', () => {
  assert.equal(fillPlaceholders('Hola {{1}}, pedido {{2}}', [{ type: 'text', text: 'Ana' }, { type: 'text', text: '7' }]), 'Hola Ana, pedido 7')
  assert.equal(fillPlaceholders('Hola {{nombre}}', [{ type: 'text', text: 'Ana', parameter_name: 'nombre' }]), 'Hola Ana')
  const r = renderTemplate(undefined, { name: 'x', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }] })
  assert.equal(r.known, false)
  assert.match(r.body, /Plantilla x/)
})

test('send text: stores message, returns wamid, then sends statuses', async () => {
  const { ctx, store, delivered } = setup()
  const res = graph(ctx, 'POST', `${ctx.config.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '5215512345678',
    type: 'text',
    text: { body: 'Hola' },
  })
  assert.equal(res.status, 200)
  const id = res.json.messages[0].id
  assert.match(id, /^wamid\.SIMOUT\./)
  assert.equal(store.state.customers['5215512345678'].waId, '5215512345678')
  await new Promise((r) => setTimeout(r, 40))
  const statuses = delivered.map((d) => d.body.entry[0].changes[0].value.statuses?.[0]?.status)
  assert.deepEqual(statuses, ['sent', 'delivered'])
  assert.equal(delivered[0].headers['x-hub-signature-256'], sign(JSON.stringify(delivered[0].body), 'secret'))
})

test('templates: create approved, list with absolute paging, delete', () => {
  const { ctx, store } = setup()
  const created = graph(ctx, 'POST', `${ctx.config.wabaId}/message_templates`, {
    name: 'prueba', language: 'es_MX', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{1}}' }],
  })
  assert.equal(created.json.status, 'APPROVED')
  const page = graph(ctx, 'GET', `${ctx.config.wabaId}/message_templates?limit=1&fields=id,name`)
  assert.equal(page.json.data.length, 1)
  assert.match(page.json.paging.next, /^https:\/\/sim\.test\/v21\.0\/\d+\/message_templates\?limit=1&after=1$/)
  const del = graph(ctx, 'DELETE', `${ctx.config.wabaId}/message_templates?name=prueba`)
  assert.equal(del.status, 200)
  assert.equal(store.state.templates.some((t) => t.name === 'prueba'), false)
})

test('unknown routes return a Graph-style error', () => {
  const { ctx } = setup()
  const res = graph(ctx, 'GET', 'nope/edges')
  assert.equal(res.status, 404)
  assert.equal(res.json.error.code, 100)
})

test('HTTP auth: Graph needs Bearer token, UI needs Basic auth', async () => {
  const { config, store, fetchImpl } = setup()
  const server = createServer(createApp(config, store, fetchImpl))
  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200)
    assert.equal((await fetch(`${base}/v21.0/${config.phoneNumberId}`)).status, 401)
    const phone = await fetch(`${base}/v21.0/${config.phoneNumberId}?fields=id`, { headers: { Authorization: 'Bearer tok' } })
    assert.equal((await phone.json()).id, config.phoneNumberId)
    assert.equal((await fetch(`${base}/`)).status, 401)
    const ui = await fetch(`${base}/ui/api/state`, {
      headers: { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` },
    })
    assert.equal(ui.status, 200)
  } finally {
    server.close()
  }
})
