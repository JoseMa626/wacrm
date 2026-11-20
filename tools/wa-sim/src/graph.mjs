// Fake WhatsApp Cloud API (Graph API) for the calls wacrm makes.
// Mirrors src/lib/whatsapp/meta-api.ts and the template sync route.

import { writeFileSync } from 'node:fs'
import { ensureCustomer, newId } from './store.mjs'
import { buildStatusPayload, deliver } from './webhook.mjs'
import { renderTemplate } from './templates.mjs'

const graphError = (status, message, code = 100) => ({
  status,
  json: { error: { message, type: 'GraphMethodException', code, fbtrace_id: 'SIMULATOR' } },
})

const ok = (json) => ({ status: 200, json })

function phoneInfo(config) {
  return {
    id: config.phoneNumberId,
    display_phone_number: config.displayPhone,
    verified_name: config.verifiedName,
    quality_rating: 'GREEN',
    whatsapp_business_manager_messaging_limit: 'TIER_1K',
  }
}

function parseJson(body) {
  if (!body || body.length === 0) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

/** Schedule the fake sent → delivered status webhooks for a business message. */
function scheduleStatuses(ctx, message) {
  const { config, store } = ctx
  const push = (status) => {
    const current = store.state.messages.find((m) => m.id === message.id)
    if (!current || current.status === 'read') return
    current.status = status
    store.save()
    deliver(config, store, buildStatusPayload(config, message.id, message.waId, status), ctx.fetchImpl)
  }
  setTimeout(() => push('sent'), config.sentDelayMs)
  setTimeout(() => push('delivered'), config.deliveredDelayMs)
}

function handleSend(ctx, body) {
  const { store } = ctx
  const state = store.state

  // Read receipt / typing indicator for an inbound message.
  if (body.status === 'read') {
    const inbound = state.messages.find((m) => m.id === body.message_id)
    if (inbound) {
      inbound.readByBusiness = true
      if (body.typing_indicator) inbound.typingAt = new Date().toISOString()
      store.save()
    }
    return ok({ success: true })
  }

  const to = String(body.to ?? body.recipient ?? '').replace(/\D/g, '')
  if (!to) return graphError(400, '(#100) The parameter to is required.')
  const customer = ensureCustomer(state, to)

  if (body.type === 'reaction') {
    const target = state.messages.find((m) => m.id === body.reaction?.message_id)
    if (target) target.reaction = body.reaction?.emoji || null
  }

  const message = {
    id: newId('wamid.SIMOUT.'),
    waId: customer.waId,
    direction: 'out',
    type: body.type,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    contextId: body.context?.message_id ?? null,
    content: body[body.type] ?? null,
  }
  if (body.type === 'template') {
    const sent = body.template ?? {}
    const definition = state.templates.find(
      (t) => t.name === sent.name && (!sent.language?.code || t.language === sent.language.code),
    )
    message.rendered = renderTemplate(definition, sent)
  }
  if (body.type !== 'reaction') state.messages.push(message)
  store.save()
  if (body.type !== 'reaction') scheduleStatuses(ctx, message)

  return ok({
    messaging_product: 'whatsapp',
    contacts: [{ input: to, wa_id: customer.waId }],
    messages: [{ id: message.id }],
  })
}

function listTemplates(ctx, req) {
  const { state } = ctx.store
  const { query } = req
  const limit = Math.max(1, Math.min(Number(query.get('limit')) || 100, 250))
  const after = Number(query.get('after') || 0)
  const page = state.templates.slice(after, after + limit)
  const next = after + limit < state.templates.length ? String(after + limit) : null
  return ok({
    data: page,
    paging: next
      ? {
          cursors: { after: next },
          next: `${ctx.baseUrl}/${req.version}/${ctx.config.wabaId}/message_templates?limit=${limit}&after=${next}`,
        }
      : {},
  })
}

/**
 * @param ctx { config, store, baseUrl, fetchImpl }
 * @param req { method, version (e.g. "v21.0"), segments (path after the version), query (URLSearchParams), body (Buffer) }
 */
export function handleGraph(ctx, req) {
  const { config, store } = ctx
  const state = store.state
  const { method, segments, query } = req
  const [first, second] = segments

  if (first === config.phoneNumberId && !second && method === 'GET') return ok(phoneInfo(config))
  if (first === config.phoneNumberId && second === 'register' && method === 'POST') {
    return ok({ success: true })
  }
  if (first === config.phoneNumberId && second === 'messages' && method === 'POST') {
    const body = parseJson(req.body)
    if (!body) return graphError(400, 'Invalid JSON body')
    return handleSend(ctx, body)
  }

  if (first === config.wabaId && second === 'subscribed_apps') {
    if (method === 'GET') {
      return ok({ data: [{ whatsapp_business_api_data: { id: config.appId, name: 'wa-sim' } }] })
    }
    return ok({ success: true })
  }
  if (first === config.wabaId && second === 'phone_numbers' && method === 'GET') {
    const { id, display_phone_number, verified_name } = phoneInfo(config)
    return ok({ data: [{ id, display_phone_number, verified_name }], paging: {} })
  }
  if (first === config.wabaId && second === 'message_templates') {
    if (method === 'GET') return listTemplates(ctx, req)
    if (method === 'POST') {
      const body = parseJson(req.body)
      if (!body?.name) return graphError(400, '(#100) Param name is required')
      const forceRejected = /reject/i.test(body.name)
      const template = {
        id: String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
        name: body.name,
        language: body.language,
        category: body.category ?? 'UTILITY',
        components: body.components ?? [],
        status: forceRejected ? 'REJECTED' : 'APPROVED',
        quality_score: { score: 'GREEN' },
      }
      state.templates = state.templates.filter(
        (t) => !(t.name === template.name && t.language === template.language),
      )
      state.templates.push(template)
      store.save()
      return ok({ id: template.id, status: template.status, category: template.category })
    }
    if (method === 'DELETE') {
      const name = query.get('name')
      const hsmId = query.get('hsm_id')
      const before = state.templates.length
      state.templates = state.templates.filter((t) => (hsmId ? t.id !== hsmId : t.name !== name))
      store.save()
      return before === state.templates.length
        ? graphError(404, 'Template not found')
        : ok({ success: true })
    }
  }

  // Template edit: POST /{template-id}
  const template = state.templates.find((t) => t.id === first)
  if (template && !second && method === 'POST') {
    const body = parseJson(req.body) ?? {}
    if (body.components) template.components = body.components
    if (body.category) template.category = body.category
    store.save()
    return ok({ success: true })
  }

  // Resumable upload: POST /{app-id}/uploads?file_name&file_length&file_type → session
  if (second === 'uploads' && method === 'POST') {
    const id = `upload:${newId('')}`
    state.uploads[id] = {
      fileName: query.get('file_name') ?? 'file',
      mimeType: query.get('file_type') ?? 'application/octet-stream',
    }
    store.save()
    return ok({ id })
  }
  if (first?.startsWith('upload:') && !second && method === 'POST') {
    const session = state.uploads[first]
    if (!session) return graphError(404, 'Upload session not found')
    const mediaId = newId('m')
    writeFileSync(store.mediaPath(mediaId), req.body)
    state.media[mediaId] = { mimeType: session.mimeType, size: req.body.length, fileName: session.fileName }
    delete state.uploads[first]
    store.save()
    return ok({ h: `4::${mediaId}` })
  }

  // Media metadata: GET /{media-id} → URL served by this simulator.
  const media = state.media[first]
  if (media && !second && method === 'GET') {
    return ok({
      id: first,
      url: `${ctx.baseUrl}/media/${first}`,
      mime_type: media.mimeType,
      file_size: media.size,
      messaging_product: 'whatsapp',
    })
  }

  return graphError(404, `Unsupported request in simulator: ${method} /${segments.join('/')}`)
}
