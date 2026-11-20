// Renders a sent template the way the customer would see it on the phone,
// substituting the parameters wacrm sends into the stored template text.

function paramText(p) {
  if (!p) return ''
  if (p.type === 'text') return String(p.text ?? '')
  if (p.type === 'currency') return String(p.currency?.fallback_value ?? '')
  if (p.type === 'date_time') return String(p.date_time?.fallback_value ?? '')
  return ''
}

/** Replace {{1}} / {{name}} placeholders with the given parameters. */
export function fillPlaceholders(text, parameters = []) {
  if (!text) return ''
  return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (match, key) => {
    const byName = parameters.find((p) => p.parameter_name === key)
    if (byName) return paramText(byName)
    const index = Number(key) - 1
    return Number.isInteger(index) && parameters[index] ? paramText(parameters[index]) : match
  })
}

/**
 * @param definition stored template ({ components }) or undefined when unknown
 * @param sent the `template` object of the send request ({ name, language, components })
 */
export function renderTemplate(definition, sent) {
  const sentComponents = Array.isArray(sent?.components) ? sent.components : []
  const paramsOf = (type) =>
    sentComponents.find((c) => String(c.type).toLowerCase() === type)?.parameters ?? []

  if (!definition) {
    const params = paramsOf('body').map(paramText).filter(Boolean)
    return {
      known: false,
      body: `[Plantilla ${sent?.name ?? '?'}]${params.length ? ` ${params.join(' · ')}` : ''}`,
      buttons: [],
    }
  }

  const out = { known: true, body: '', buttons: [] }
  for (const component of definition.components ?? []) {
    const type = String(component.type).toUpperCase()
    if (type === 'HEADER') {
      const params = paramsOf('header')
      if (component.format === 'TEXT' || !component.format) {
        out.header = { format: 'TEXT', text: fillPlaceholders(component.text, params) }
      } else {
        const media = params[0]?.[String(component.format).toLowerCase()]
        out.header = { format: component.format, link: media?.link ?? null }
      }
    } else if (type === 'BODY') {
      out.body = fillPlaceholders(component.text, paramsOf('body'))
    } else if (type === 'FOOTER') {
      out.footer = component.text
    } else if (type === 'BUTTONS') {
      out.buttons = (component.buttons ?? []).map((b, index) => {
        const sentButton = sentComponents.find(
          (c) => String(c.type).toLowerCase() === 'button' && Number(c.index) === index,
        )
        const payload = sentButton?.parameters?.[0]?.payload ?? b.text
        return { type: b.type, text: b.text, url: b.url, phone_number: b.phone_number, payload }
      })
    }
  }
  return out
}
