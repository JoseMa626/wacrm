// wa-sim: fake WhatsApp Cloud API + customer phone web page for wacrm.
//
//   /v21.0/...              Graph API look-alike (Bearer SIM_ACCESS_TOKEN)
//   /media/:id              uploaded media bytes (Bearer SIM_ACCESS_TOKEN)
//   /health                 liveness probe (no auth)
//   /, /app.js, /styles.css customer phone page (Basic auth SIM_UI_USER / SIM_UI_PASSWORD)
//   /ui/api/...             JSON API used by that page (Basic auth)

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import { assertConfig, loadConfig } from './config.mjs'
import { createStore, ensureCustomer } from './store.mjs'
import { handleGraph } from './graph.mjs'
import { buildInboundPayload, buildStatusPayload, deliver } from './webhook.mjs'

const MAX_BODY = 25 * 1024 * 1024
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, status, json, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders })
  res.end(JSON.stringify(json))
}

function baseUrlOf(config, req) {
  if (config.publicBaseUrl) return config.publicBaseUrl
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || 'http'
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`
}

/** Summary of each fake customer for the sidebar. */
function customerList(state) {
  return Object.values(state.customers)
    .map((c) => {
      const msgs = state.messages.filter((m) => m.waId === c.waId)
      const last = msgs[msgs.length - 1] ?? null
      return {
        ...c,
        lastAt: last?.createdAt ?? c.createdAt,
        lastPreview: last ? preview(last) : '',
        unread: msgs.filter((m) => m.direction === 'out' && m.status !== 'read').length,
      }
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

function preview(m) {
  if (m.direction === 'in') return m.text ?? m.replyTitle ?? ''
  if (m.type === 'text') return m.content?.body ?? ''
  if (m.type === 'template') return m.rendered?.body ?? 'Plantilla'
  if (m.type === 'interactive') return m.content?.body?.text ?? 'Mensaje interactivo'
  return `[${m.type}]`
}

export function createApp(config, store, fetchImpl = fetch) {
  const state = () => store.state

  async function handleUiApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean) // ui, api, ...
    const [, , resource, waId, sub] = parts

    if (resource === 'state' && req.method === 'GET') {
      return send(res, 200, {
        business: { name: config.verifiedName, phone: config.displayPhone },
        customers: customerList(state()),
        lastWebhook: state().webhookLog[0] ?? null,
      })
    }

    if (resource === 'customers' && !waId && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const digits = String(body.waId ?? '').replace(/\D/g, '')
      if (digits.length < 8 || digits.length > 15) {
        return send(res, 400, { error: 'El número debe tener entre 8 y 15 dígitos, con lada de país.' })
      }
      const customer = ensureCustomer(state(), digits, body.name)
      store.save()
      return send(res, 201, customer)
    }

    const customer = waId ? state().customers[waId] : null
    if (resource === 'customers' && waId && !customer) return send(res, 404, { error: 'Cliente no encontrado' })

    if (resource === 'customers' && customer && !sub && req.method === 'DELETE') {
      state().messages = state().messages.filter((m) => m.waId !== customer.waId)
      delete state().customers[customer.waId]
      store.save()
      return send(res, 200, { ok: true })
    }

    if (resource === 'customers' && customer && sub === 'messages' && req.method === 'GET') {
      const messages = state().messages.filter((m) => m.waId === customer.waId)
      // Opening the chat "reads" the business messages, like the real app.
      for (const m of messages) {
        if (m.direction === 'out' && m.status !== 'read') {
          m.status = 'read'
          deliver(config, store, buildStatusPayload(config, m.id, customer.waId, 'read'), fetchImpl)
        }
      }
      store.save()
      return send(res, 200, { customer, messages })
    }

    if (resource === 'customers' && customer && sub === 'messages' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      let input
      if (body.reply?.id) input = { reply: body.reply }
      else if (body.quickReply?.payload) input = { quickReply: body.quickReply }
      else if (String(body.text ?? '').trim()) input = { text: String(body.text).trim() }
      else return send(res, 400, { error: 'Mensaje vacío' })

      const { message, payload } = buildInboundPayload(config, customer, input, body.contextId)
      state().messages.push({
        id: message.id,
        waId: customer.waId,
        direction: 'in',
        type: message.type,
        createdAt: new Date().toISOString(),
        contextId: body.contextId ?? null,
        text: input.text,
        replyTitle: input.reply?.title ?? input.quickReply?.text,
      })
      store.save()
      const delivery = await deliver(config, store, payload, fetchImpl)
      return send(res, delivery.ok ? 201 : 502, { id: message.id, delivery })
    }

    return send(res, 404, { error: 'Ruta no encontrada' })
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://local')
      const path = url.pathname

      if (path === '/health') return send(res, 200, { ok: true })

      // Graph API and media: wacrm authenticates with the fake access token.
      const version = path.match(/^\/(v\d+\.\d+)\//)?.[1]
      if (version || path.startsWith('/media/')) {
        const auth = req.headers.authorization ?? ''
        if (!safeEqual(auth, `Bearer ${config.accessToken}`)) {
          return send(res, 401, {
            error: { message: 'Invalid OAuth access token (simulator).', type: 'OAuthException', code: 190 },
          })
        }
        if (!version) {
          const id = path.slice('/media/'.length)
          const media = state().media[id]
          if (!media || !existsSync(store.mediaPath(id))) return send(res, 404, { error: 'Not found' })
          res.writeHead(200, { 'Content-Type': media.mimeType })
          return res.end(readFileSync(store.mediaPath(id)))
        }
        const body = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req)
        const segments = path.slice(version.length + 2).split('/').filter(Boolean).map(decodeURIComponent)
        const result = handleGraph(
          { config, store, baseUrl: baseUrlOf(config, req), fetchImpl },
          { method: req.method, version, segments, query: url.searchParams, body },
        )
        return send(res, result.status, result.json)
      }

      // Everything else is the customer page: Basic auth.
      const expected = `Basic ${Buffer.from(`${config.uiUser}:${config.uiPassword}`).toString('base64')}`
      if (!safeEqual(req.headers.authorization ?? '', expected)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="wa-sim", charset="UTF-8"' })
        return res.end('Autenticación requerida')
      }

      if (path.startsWith('/ui/api/')) return await handleUiApi(req, res, url)

      const asset = STATIC[path]
      if (asset && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': asset[1],
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        })
        return res.end(readFileSync(join(PUBLIC_DIR, asset[0])))
      }
      return send(res, 404, { error: 'Not found' })
    } catch (err) {
      console.error('[wa-sim]', err)
      return send(res, 500, { error: 'Internal simulator error' })
    }
  }
}

// Start only when run directly (tests import createApp).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig()
  assertConfig(config)
  const store = createStore(config.dataDir)
  const server = createServer(createApp(config, store))
  server.listen(config.port, () => {
    console.log(`[wa-sim] listening on :${config.port} — phone ${config.phoneNumberId}, WABA ${config.wabaId}`)
  })
  const stop = () => {
    store.flush()
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
