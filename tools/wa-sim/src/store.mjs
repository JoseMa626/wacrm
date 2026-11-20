// Persistent state in a single JSON file (atomic write: temp file + rename).
// Uploaded media bytes live next to it in `<dataDir>/media/`.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const EMPTY = () => ({ customers: {}, messages: [], templates: [], media: {}, uploads: {}, webhookLog: [] })

/** Templates every fresh simulator starts with, so a first "sync" is not empty. */
export const SEED_TEMPLATES = [
  {
    name: 'hello_world',
    language: 'en_US',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hello World' },
      {
        type: 'BODY',
        text: 'Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us.',
      },
      { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' },
    ],
  },
]

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${randomBytes(6).toString('hex')}`
}

export function createStore(dataDir) {
  mkdirSync(join(dataDir, 'media'), { recursive: true })
  const file = join(dataDir, 'state.json')
  let state = EMPTY()
  if (existsSync(file)) {
    state = { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) }
  }
  if (state.templates.length === 0) {
    state.templates = SEED_TEMPLATES.map((t, i) => ({
      ...t,
      id: String(900000000000000 + i),
      status: 'APPROVED',
      quality_score: { score: 'GREEN' },
    }))
  }

  let timer = null
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, file)
    }, 150)
  }

  return {
    get state() {
      return state
    },
    save,
    mediaPath: (mediaId) => join(dataDir, 'media', mediaId),
    flush() {
      clearTimeout(timer)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, file)
    },
  }
}

/** Get or create a fake customer by WhatsApp id (digits only). */
export function ensureCustomer(state, waId, name) {
  const id = String(waId).replace(/\D/g, '')
  if (!state.customers[id]) {
    state.customers[id] = {
      waId: id,
      name: name?.trim() || `Cliente ${id.slice(-4)}`,
      createdAt: new Date().toISOString(),
    }
  } else if (name?.trim()) {
    state.customers[id].name = name.trim()
  }
  return state.customers[id]
}
