// SDK log — shows every Zoom Video SDK call the page makes, and the events Zoom sends back.
//
// The SDK objects are wrapped in a Proxy, so the app code calls the SDK exactly as it normally
// would (zmClient.join, stream.startAudio, liveTranscription.setTranslationLanguage, …) and each
// call is recorded with its arguments, result or error, and how long it took. Calls are grouped
// under the button you clicked, so you can see which SDK functions a button uses.

const sdkLog = (function () {
  const MAX_ENTRIES = 600

  // Objects returned by these methods are wrapped too, under the name used in Zoom's docs
  const WRAP_RESULTS = {
    createClient: 'client',
    getMediaStream: 'stream',
    getChatClient: 'chat',
    getRecordingClient: 'recording',
    getLiveTranscriptionClient: 'liveTranscription',
    createLocalVideoTrack: 'localVideoTrack',
    createLocalAudioTrack: 'localAudioTrack'
  }

  // Events that fire constantly; shown only with "Noisy events" ticked
  const NOISY_EVENTS = new Set([
    'network-quality-change', 'video-statistic-data-change', 'audio-statistic-data-change',
    'share-statistic-data-change', 'video-active-change', 'active-speaker', 'media-sdk-change',
    'current-audio-change', 'video-detailed-data-change', 'share-content-dimension-change'
  ])

  const wrapped = new WeakMap()
  const entries = []
  let currentAction = null
  let seq = 0
  let open = false
  const filters = { getters: false, events: true, noisy: false }

  function isGetter(name) {
    return /^(get|is|can)[A-Z]/.test(name)
  }

  // ---------- Formatting ----------

  function describeElement(el) {
    return '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '>'
  }

  function formatValue(value, depth) {
    depth = depth || 0
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'string') {
      if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return '"' + value.slice(0, 12) + '…" /* JWT */'
      return JSON.stringify(value.length > 120 ? value.slice(0, 120) + '…' : value)
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (typeof value === 'function') return 'ƒ ' + (value.name || 'handler')
    if (typeof Element !== 'undefined' && value instanceof Element) return describeElement(value)
    if (value instanceof Error) return 'Error(' + JSON.stringify(value.message) + ')'
    if (depth > 2) return Array.isArray(value) ? '[…]' : '{…}'
    if (Array.isArray(value)) {
      const items = value.slice(0, 6).map((v) => formatValue(v, depth + 1))
      return '[' + items.join(', ') + (value.length > 6 ? ', … ' + (value.length - 6) + ' more' : '') + ']'
    }
    try {
      const keys = Object.keys(value)
      const parts = keys.slice(0, 8).map((k) => k + ': ' + formatValue(value[k], depth + 1))
      if (!keys.length) return '{}'
      return '{ ' + parts.join(', ') + (keys.length > 8 ? ', …' : '') + ' }'
    } catch (e) {
      return String(value)
    }
  }

  function formatArgs(args) {
    return args.map((a) => formatValue(a)).join(', ')
  }

  // SDK errors come back as plain objects ({ type, reason, errorCode }) as well as Error instances
  function formatError(error) {
    if (!error) return 'unknown error'
    const reason = error.reason || error.message || error.type
    return reason ? String(reason) + (error.errorCode ? ' (code ' + error.errorCode + ')' : '') : formatValue(error)
  }

  // ---------- Recording ----------

  function add(entry) {
    entry.id = ++seq
    entry.time = new Date()
    entry.action = currentAction
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    scheduleRender()
    return entry
  }

  function update(entry) {
    scheduleRender()
    return entry
  }

  // ---------- Proxy ----------

  function instrument(target, label) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target
    if (wrapped.has(target)) return wrapped.get(target)

    const proxy = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj)
        if (typeof prop !== 'string' || typeof value !== 'function') return value
        // Proxy rules: a non-configurable, read-only property must be returned as-is
        const own = Object.getOwnPropertyDescriptor(obj, prop)
        if (own && !own.configurable && !own.writable) return value
        if (prop === 'constructor') return value
        if (prop === 'on' || prop === 'off') return wrapEventMethod(obj, value, label, prop)
        return function () {
          return callAndLog(obj, value, label, prop, Array.prototype.slice.call(arguments))
        }
      }
    })
    wrapped.set(target, proxy)
    return proxy
  }

  function callAndLog(obj, fn, label, name, args) {
    const entry = { kind: 'call', label: label, name: name, args: args, getter: isGetter(name), status: 'pending' }
    const started = performance.now()
    let result
    try {
      result = fn.apply(obj, args)
    } catch (error) {
      entry.status = 'error'
      entry.result = formatError(error)
      entry.ms = performance.now() - started
      if (!entry.getter) add(entry)
      throw error
    }

    let wrappedAs = null
    if (WRAP_RESULTS[name] && result && typeof result === 'object' && typeof result.then !== 'function') {
      result = instrument(result, WRAP_RESULTS[name])
      wrappedAs = WRAP_RESULTS[name]
    }

    // Getters run constantly (layout, lists); keep them only when "Getters" is ticked
    if (entry.getter && !filters.getters) return result
    add(entry)

    if (result && typeof result.then === 'function') {
      result.then((value) => {
        entry.ms = performance.now() - started
        // Several SDK methods resolve with an Error object instead of rejecting
        if (value instanceof Error) { entry.status = 'error'; entry.result = formatError(value) }
        else { entry.status = 'ok'; entry.result = value === undefined || value === '' ? '' : formatValue(value) }
        update(entry)
      }, (error) => {
        entry.ms = performance.now() - started
        entry.status = 'error'
        entry.result = formatError(error)
        update(entry)
      })
    } else {
      entry.ms = performance.now() - started
      entry.status = result instanceof Error ? 'error' : 'ok'
      entry.result = result instanceof Error ? formatError(result)
        : wrappedAs ? wrappedAs + ' object'
        : (result === undefined ? '' : formatValue(result))
    }
    return result
  }

  // client.on('event', handler): log the event each time Zoom fires it
  function wrapEventMethod(obj, fn, label, method) {
    return function (eventName, handler) {
      if (method === 'on' && typeof handler === 'function') {
        const logged = function (payload) {
          const noisy = NOISY_EVENTS.has(eventName) || (eventName === 'caption-message' && payload && payload.done === false)
          add({ kind: 'event', label: label, name: eventName, payload: payload, noisy: noisy })
          return handler.apply(this, arguments)
        }
        return fn.call(obj, eventName, logged)
      }
      return fn.apply(obj, arguments)
    }
  }

  // ---------- Which button was clicked ----------

  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, select, input[type="checkbox"], .menu-item')
    if (!target || target.closest('#sdk-log')) return
    const text = (target.getAttribute('aria-label') || target.textContent || target.id || target.tagName).trim().replace(/\s+/g, ' ')
    currentAction = { label: text.slice(0, 48), id: ++seq }
  }, true)

  document.addEventListener('change', (e) => {
    const target = e.target
    if (!target.matches || !target.matches('select') || target.closest('#sdk-log')) return
    const label = (target.closest('label') ? target.closest('label').firstChild.textContent.trim() : target.id) + ' → ' + target.selectedOptions[0].textContent
    currentAction = { label: label.slice(0, 48), id: ++seq }
  }, true)

  // ---------- Panel ----------

  let renderQueued = false
  function scheduleRender() {
    if (!open || renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => { renderQueued = false; render() })
  }

  function visible(entry) {
    if (entry.kind === 'event') return filters.events && (!entry.noisy || filters.noisy)
    return !entry.getter || filters.getters
  }

  function signature(entry) {
    if (entry.kind === 'event') return "client.on('" + entry.name + "')"
    return entry.label + '.' + entry.name + '(' + formatArgs(entry.args) + ')'
  }

  function render() {
    const list = document.querySelector('#sdk-log-list')
    if (!list) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60
    list.innerHTML = ''
    let lastAction = null
    let shown = 0
    entries.forEach((entry) => {
      if (!visible(entry)) return
      shown++
      if (entry.action && entry.action !== lastAction) {
        const group = document.createElement('li')
        group.className = 'log-action'
        group.textContent = '🖱 ' + entry.action.label
        list.appendChild(group)
      }
      lastAction = entry.action
      list.appendChild(renderEntry(entry))
    })
    document.querySelector('#sdk-log-count').textContent = shown + ' shown'
    if (nearBottom) list.scrollTop = list.scrollHeight
  }

  function renderEntry(entry) {
    const item = document.createElement('li')
    item.className = 'log-' + entry.kind + ' ' + (entry.status || '')
    const head = document.createElement('div')
    head.className = 'log-head'

    const time = document.createElement('span')
    time.className = 'log-time'
    time.textContent = entry.time.toLocaleTimeString([], { hour12: false }) + '.' + String(entry.time.getMilliseconds()).padStart(3, '0')

    const badge = document.createElement('span')
    badge.className = 'log-badge'
    badge.textContent = entry.kind === 'event' ? 'EVENT' : entry.status === 'pending' ? '…' : entry.status === 'error' ? 'ERROR' : 'OK'

    const code = document.createElement('code')
    code.textContent = signature(entry)

    head.append(time, badge, code)
    item.appendChild(head)

    let detail = ''
    if (entry.kind === 'event') detail = formatValue(entry.payload)
    else if (entry.status === 'error') detail = '✗ ' + entry.result
    else if (entry.result) detail = '→ ' + entry.result
    if (entry.kind === 'call' && entry.ms !== undefined && entry.status !== 'pending') {
      detail += (detail ? '  ' : '') + '(' + Math.round(entry.ms) + ' ms)'
    }
    if (detail) {
      const d = document.createElement('div')
      d.className = 'log-detail'
      d.textContent = detail
      item.appendChild(d)
    }
    return item
  }

  function asText() {
    return entries.filter(visible).map((e) => {
      const t = e.time.toISOString().slice(11, 23)
      const action = e.action ? '[' + e.action.label + '] ' : ''
      if (e.kind === 'event') return t + ' ' + action + 'EVENT ' + e.name + ' ' + formatValue(e.payload)
      return t + ' ' + action + signature(e) + ' ' + (e.status === 'error' ? '✗ ' + e.result : (e.result ? '→ ' + e.result : '✓'))
    }).join('\n')
  }

  function toggle(force) {
    open = typeof force === 'boolean' ? force : !open
    document.querySelector('#sdk-log').hidden = !open
    document.querySelectorAll('.sdk-log-toggle').forEach((b) => b.classList.toggle('active', open))
    if (open) render()
  }

  function wire() {
    document.querySelectorAll('.sdk-log-toggle').forEach((b) => b.addEventListener('click', () => toggle()))
    document.querySelector('#sdk-log-close').addEventListener('click', () => toggle(false))
    document.querySelector('#sdk-log-clear').addEventListener('click', () => { entries.length = 0; currentAction = null; render() })
    document.querySelector('#sdk-log-copy').addEventListener('click', () => {
      const text = asText()
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => window.prompt('Copy:', text))
      else window.prompt('Copy:', text)
    })
    ;['getters', 'events', 'noisy'].forEach((key) => {
      const box = document.querySelector('#sdk-log-' + key)
      box.checked = filters[key]
      box.addEventListener('change', () => { filters[key] = box.checked; render() })
    })
    // Drag the window by its header
    const panel = document.querySelector('#sdk-log')
    const head = panel.querySelector('.sdk-log-head')
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return
      const rect = panel.getBoundingClientRect()
      const dx = e.clientX - rect.left
      const dy = e.clientY - rect.top
      head.setPointerCapture(e.pointerId)
      const move = (ev) => {
        const left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 80)
        const top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40)
        panel.style.left = left + 'px'
        panel.style.top = top + 'px'
        panel.style.right = 'auto'
      }
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up) }
      head.addEventListener('pointermove', move)
      head.addEventListener('pointerup', up)
    })
    // Ctrl/Cmd + Shift + L toggles the log
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggle() }
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire)
  else wire()

  return { instrument: instrument, toggle: toggle, entries: entries }
})()
