// Builds and delivers webhook payloads in the exact shape Meta uses, signed
// with HMAC-SHA256 like Meta's `x-hub-signature-256` header.

import { createHmac } from 'node:crypto'
import { newId } from './store.mjs'

export function sign(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

const nowSeconds = () => String(Math.floor(Date.now() / 1000))

function envelope(config, value) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: config.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: config.displayPhone.replace(/\D/g, ''),
                phone_number_id: config.phoneNumberId,
              },
              ...value,
            },
          },
        ],
      },
    ],
  }
}

/**
 * Inbound customer message. `input` is one of:
 *   { text }                                    → type "text"
 *   { reply: { kind: 'button_reply' | 'list_reply', id, title, description? } }
 *                                               → type "interactive"
 *   { quickReply: { payload, text } }           → type "button" (template quick reply)
 * `contextId` links the reply to the business message it answers.
 */
export function buildInboundPayload(config, customer, input, contextId) {
  const message = { from: customer.waId, id: newId('wamid.SIMIN.'), timestamp: nowSeconds() }
  if (contextId) {
    message.context = { from: config.displayPhone.replace(/\D/g, ''), id: contextId }
  }
  if (input.reply) {
    const { kind, id, title, description } = input.reply
    message.type = 'interactive'
    message.interactive =
      kind === 'list_reply'
        ? { type: 'list_reply', list_reply: { id, title, ...(description ? { description } : {}) } }
        : { type: 'button_reply', button_reply: { id, title } }
  } else if (input.quickReply) {
    message.type = 'button'
    message.button = { payload: input.quickReply.payload, text: input.quickReply.text }
  } else {
    message.type = 'text'
    message.text = { body: String(input.text ?? '') }
  }
  return {
    message,
    payload: envelope(config, {
      contacts: [{ profile: { name: customer.name }, wa_id: customer.waId }],
      messages: [message],
    }),
  }
}

/** Delivery status of a business message: sent / delivered / read / failed. */
export function buildStatusPayload(config, messageId, recipientId, status) {
  return envelope(config, {
    statuses: [
      {
        id: messageId,
        status,
        timestamp: nowSeconds(),
        recipient_id: recipientId,
        ...(status === 'failed'
          ? { errors: [{ code: 131000, title: 'Simulated failure', message: 'Simulated failure' }] }
          : {}),
      },
    ],
  })
}

/**
 * POST a payload to wacrm. Never throws: the result is recorded in the
 * webhook log so the customer page can show delivery problems.
 */
export async function deliver(config, store, payload, fetchImpl = fetch) {
  const raw = JSON.stringify(payload)
  const entry = { at: new Date().toISOString(), ok: false, status: 0, error: '' }
  try {
    const res = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(raw, config.appSecret) },
      body: raw,
    })
    entry.status = res.status
    entry.ok = res.ok
    if (!res.ok) entry.error = (await res.text().catch(() => '')).slice(0, 300)
  } catch (err) {
    entry.error = String(err?.message || err)
  }
  const log = store.state.webhookLog
  log.unshift(entry)
  log.length = Math.min(log.length, 20)
  store.save()
  return entry
}
