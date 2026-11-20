// Runtime configuration from environment variables. Secrets have no defaults:
// the server refuses to start without them (see `assertConfig`).

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3001),
    dataDir: env.DATA_DIR || './data',
    accessToken: env.SIM_ACCESS_TOKEN || '',
    appSecret: env.SIM_APP_SECRET || '',
    phoneNumberId: env.SIM_PHONE_NUMBER_ID || '100000000000001',
    wabaId: env.SIM_WABA_ID || '200000000000001',
    appId: env.SIM_APP_ID || 'sim-app',
    displayPhone: env.SIM_DISPLAY_PHONE || '+1 555 010 0000',
    verifiedName: env.SIM_VERIFIED_NAME || 'Simulador wacrm',
    webhookUrl: env.WACRM_WEBHOOK_URL || '',
    uiUser: env.SIM_UI_USER || '',
    uiPassword: env.SIM_UI_PASSWORD || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    // Delays (ms) before the fake "sent" and "delivered" status webhooks.
    sentDelayMs: Number(env.SIM_SENT_DELAY_MS ?? 600),
    deliveredDelayMs: Number(env.SIM_DELIVERED_DELAY_MS ?? 1500),
  }
}

export function assertConfig(config) {
  const missing = []
  if (!config.accessToken) missing.push('SIM_ACCESS_TOKEN')
  if (!config.appSecret) missing.push('SIM_APP_SECRET')
  if (!config.webhookUrl) missing.push('WACRM_WEBHOOK_URL')
  if (!config.uiUser || !config.uiPassword) missing.push('SIM_UI_USER / SIM_UI_PASSWORD')
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`)
  }
}
