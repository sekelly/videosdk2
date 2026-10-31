// Live captions, transcript and translation
// Docs: https://developers.zoom.us/docs/video-sdk/web/transcription-translation/
// API:  https://marketplacefront.zoom.us/sdk/custom/web/modules/LiveTranscriptionClient.html
//
// Live transcription and translation must be enabled for the Video SDK account that signs the token
// (translation is a separate add-on). caption-message events carry a numeric language code; when
// translation is on, each utterance arrives twice: the original (language 400 = NoTranslation)
// and the translated text (the target language's code).

const STORAGE_CAPTIONS = 'vsdk-playground-captions'

// LiveTranscriptionLanguage (string, used to set languages) ↔ LiveTranscriptionLanguageCode (number, in messages)
const CAPTION_LANGUAGES = [
  ['en', 'English', 0], ['zh', 'Chinese (Simplified)', 1], ['ja', 'Japanese', 2], ['de', 'German', 3],
  ['fr', 'French', 4], ['ru', 'Russian', 5], ['pt', 'Portuguese', 6], ['es', 'Spanish', 7],
  ['ko', 'Korean', 8], ['it', 'Italian', 9], ['vi', 'Vietnamese', 11], ['nl', 'Dutch', 12],
  ['uk', 'Ukrainian', 13], ['ar', 'Arabic', 14], ['zh-hant', 'Chinese (Traditional)', 16], ['cs', 'Czech', 17],
  ['et', 'Estonian', 18], ['fi', 'Finnish', 19], ['he', 'Hebrew', 21], ['hi', 'Hindi', 22],
  ['hu', 'Hungarian', 23], ['id', 'Indonesian', 24], ['ms', 'Malay', 25], ['fa', 'Persian', 26],
  ['pl', 'Polish', 27], ['ro', 'Romanian', 28], ['sv', 'Swedish', 29], ['ta', 'Tamil', 30],
  ['te', 'Telugu', 31], ['tl', 'Tagalog', 32], ['tr', 'Turkish', 33], ['fr-ca', 'French (Canada)', 34],
  ['da', 'Danish', 35], ['th', 'Thai', 37], ['zh-yue', 'Cantonese', 44]
].map(([code, name, num]) => ({ code, name, num }))
const NO_TRANSLATION = 400

let ltClient = null
let transcriptionStarted = false
let captionsVisible = false
let transcript = []                 // { key, userId, name, text, translation, ts, done }
const transcriptIndex = new Map()   // key -> entry
const overlayLines = new Map()      // userId -> { entry, updated }
let overlayTimer = null
let captionPrefs = { speaking: '', translation: '', size: 'medium', show: 'translated' }

try { Object.assign(captionPrefs, JSON.parse(localStorage.getItem(STORAGE_CAPTIONS) || '{}')) } catch (e) { /* ignore */ }

function saveCaptionPrefs() {
  try { localStorage.setItem(STORAGE_CAPTIONS, JSON.stringify(captionPrefs)) } catch (e) { /* storage blocked */ }
}

function findLanguage(value) {
  if (value === null || value === undefined || value === '') return null
  const v = String(value).trim().toLowerCase()
  return CAPTION_LANGUAGES.find((l) => l.code === v || l.name.toLowerCase() === v || String(l.num) === v) || null
}

function resultError(result) {
  return result instanceof Error ? result : null
}

function describeError(error) {
  return (error && (error.reason || error.message || error.type)) || String(error)
}

// ---------- Status & language lists ----------

function captionStatus() {
  try { return (ltClient && ltClient.getLiveTranscriptionStatus()) || {} } catch (e) { return {} }
}

function parseLanguages(list) {
  const out = []
  ;(Array.isArray(list) ? list : String(list || '').split(/[;,]/)).forEach((item) => {
    const lang = findLanguage(item)
    if (lang && !out.includes(lang)) out.push(lang)
  })
  return out
}

function speakingOptions() {
  const supported = parseLanguages(captionStatus().transcriptionLanguage)
  return supported.length ? supported : CAPTION_LANGUAGES
}

function translationOptions(speakingCode) {
  const status = captionStatus()
  const pairs = Array.isArray(status.translationLanguage) ? status.translationLanguage : []
  const speaking = findLanguage(speakingCode)
  if (!pairs.length) return CAPTION_LANGUAGES
  const targets = []
  pairs.forEach((pair) => {
    const from = findLanguage(pair.speakingLanguage)
    if (speaking && from && from !== speaking) return
    parseLanguages(pair.translatedToLanguage).forEach((l) => { if (!targets.includes(l)) targets.push(l) })
  })
  return targets.length ? targets : CAPTION_LANGUAGES
}

function currentSpeakingCode() {
  try {
    const lang = ltClient && ltClient.getCurrentTranscriptionLanguage()
    const found = lang && findLanguage(lang.code || lang.name || lang)
    if (found) return found.code
  } catch (e) { /* ignore */ }
  return captionPrefs.speaking || 'en'
}

function fillLanguageSelect(select, languages, value, offLabel) {
  select.innerHTML = ''
  if (offLabel) select.add(new Option(offLabel, ''))
  languages.forEach((l) => select.add(new Option(l.name, l.code)))
  select.value = [...select.options].some((o) => o.value === value) ? value : (offLabel ? '' : select.options[0].value)
}

function renderCaptionSettings() {
  if (!ltClient) return
  const status = captionStatus()
  const speaking = currentSpeakingCode()
  fillLanguageSelect($('#speakingLanguage'), speakingOptions(), speaking)

  const translationOff = status.isLiveTranslationEnabled === false
  fillLanguageSelect($('#translationLanguage'), translationOff ? [] : translationOptions(speaking), captionPrefs.translation, 'Off — no translation')
  $('#translationLanguage').disabled = translationOff

  $('#captionSize').value = captionPrefs.size
  $('#captionShow').value = captionPrefs.show
  updateCaptionHostControls()

  const hints = []
  if (status.isLiveTranscriptionEnabled === false) hints.push('Live transcription is not enabled for the Video SDK account that signed this session.')
  if (translationOff) hints.push('Translation is a separate add-on and is not enabled for this account.')
  if (status.isHostDisableCaptions) hints.push('The host has turned captions off for everyone.')
  if (!transcriptionStarted && !hints.length) hints.push('Turn on CC or choose a language to start transcription.')
  $('#captionHint').textContent = hints.join(' ')
}

function updateCaptionHostControls() {
  if (!ltClient) return
  const isHost = !!(zmClient.isHost && zmClient.isHost())
  show('#hostCaptionRow', isHost)
  $('#hostDisableCaptions').checked = !!captionStatus().isHostDisableCaptions
}

// ---------- Starting & languages ----------

async function ensureTranscription() {
  if (!ltClient) throw new Error('Live transcription is not available in this SDK version')
  if (captionStatus().isHostDisableCaptions) throw new Error('The host has turned captions off')
  if (transcriptionStarted) return
  const err = resultError(await ltClient.startLiveTranscription())
  if (err) throw err
  transcriptionStarted = true

  if (captionPrefs.speaking) await applySpeakingLanguage(captionPrefs.speaking, true)
  if (captionPrefs.translation) await applyTranslationLanguage(captionPrefs.translation, true)
  loadTranscriptHistory()
  if (openPanel === 'captions') renderCaptionSettings()
}

async function applySpeakingLanguage(code, quiet) {
  try {
    const err = resultError(await ltClient.setSpeakingLanguage(code))
    if (err) throw err
  } catch (error) {
    if (!quiet) toast('Could not set speaking language: ' + describeError(error))
  }
}

async function applyTranslationLanguage(code, quiet) {
  try {
    // No argument turns translation off
    const err = resultError(await (code ? ltClient.setTranslationLanguage(code) : ltClient.setTranslationLanguage()))
    if (err) throw err
  } catch (error) {
    if (!quiet) toast('Could not set translation language: ' + describeError(error))
    captionPrefs.translation = ''
    saveCaptionPrefs()
    if (openPanel === 'captions') renderCaptionSettings()
  }
}

async function onSpeakingChange(code) {
  captionPrefs.speaking = code
  saveCaptionPrefs()
  try {
    await ensureTranscription()
    await applySpeakingLanguage(code)
  } catch (error) {
    toast('Captions: ' + describeError(error))
  }
  // The translation targets available depend on the speaking language
  const targets = translationOptions(code)
  if (captionPrefs.translation && !targets.some((l) => l.code === captionPrefs.translation)) {
    captionPrefs.translation = ''
    saveCaptionPrefs()
    if (transcriptionStarted) applyTranslationLanguage('', true)
    toast('Translation turned off: not available from this speaking language', 'info')
  }
  renderCaptionSettings()
}

async function onTranslationChange(code) {
  captionPrefs.translation = code
  saveCaptionPrefs()
  try {
    await ensureTranscription()
    await applyTranslationLanguage(code)
    if (code && !captionsVisible) setCaptionsVisible(true)
  } catch (error) {
    toast('Captions: ' + describeError(error))
  }
  renderOverlay()
}

// ---------- Messages, transcript, overlay ----------

function translationTarget() {
  const lang = findLanguage(captionPrefs.translation)
  return lang ? lang.num : null
}

function handleCaptionMessage(msg, fromHistory) {
  if (!msg || !msg.text) return
  const target = translationTarget()
  const isTranslation = target !== null && msg.language === target && msg.language !== NO_TRANSLATION
  const key = String(msg.msgId || (msg.userId + '-' + msg.timestamp))

  let entry = transcriptIndex.get(key)
  if (!entry) {
    entry = { key: key, userId: msg.userId, name: msg.displayName || 'Someone', text: '', translation: '', ts: msg.timestamp || Date.now(), done: false }
    transcriptIndex.set(key, entry)
    transcript.push(entry)
  }
  if (isTranslation) entry.translation = msg.text
  else entry.text = msg.text
  entry.done = msg.done !== false

  renderTranscriptEntry(entry)
  if (!fromHistory) {
    overlayLines.set(entry.userId, { entry: entry, updated: Date.now() })
    renderOverlay()
  }
}

function loadTranscriptHistory() {
  if (transcript.length || !ltClient || !ltClient.getFullTranscriptionHistory) return
  Promise.resolve(ltClient.getFullTranscriptionHistory())
    .then((history) => { (history || []).forEach((m) => handleCaptionMessage(m, true)) })
    .catch((e) => console.log('transcription history unavailable', e))
}

function formatTime(ts) {
  const d = new Date(ts > 1e12 ? ts : ts * 1000)
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function renderTranscriptEntry(entry) {
  const list = $('#transcript-list')
  if (!list) return
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
  let item = list.querySelector('[data-key="' + CSS.escape(entry.key) + '"]')
  if (!item) {
    item = document.createElement('li')
    item.dataset.key = entry.key
    item.innerHTML = '<div class="meta"></div><div class="text"></div><div class="translation"></div>'
    list.appendChild(item)
  }
  item.classList.toggle('partial', !entry.done)
  item.querySelector('.meta').textContent = entry.name + ' · ' + formatTime(entry.ts)
  item.querySelector('.text').textContent = entry.text
  const tr = item.querySelector('.translation')
  tr.textContent = entry.translation ? '→ ' + entry.translation : ''
  tr.hidden = !entry.translation
  if (nearBottom) list.scrollTop = list.scrollHeight
}

function renderOverlay() {
  const overlay = $('#caption-overlay')
  if (!overlay) return
  const now = Date.now()
  const lines = []
  overlayLines.forEach((line, userId) => {
    if (now - line.updated > 7000) overlayLines.delete(userId)
    else lines.push(line)
  })
  lines.sort((a, b) => a.updated - b.updated)

  overlay.className = 'size-' + captionPrefs.size
  overlay.innerHTML = ''
  const translating = translationTarget() !== null
  lines.slice(-3).forEach(({ entry }) => {
    const row = document.createElement('div')
    row.className = 'caption-line'
    const who = document.createElement('span')
    who.className = 'speaker'
    who.textContent = entry.name + ': '
    const main = document.createElement('span')
    main.textContent = translating ? (entry.translation || entry.text) : entry.text
    row.append(who, main)
    if (translating && captionPrefs.show === 'both' && entry.translation && entry.text) {
      const original = document.createElement('div')
      original.className = 'original'
      original.textContent = entry.text
      row.appendChild(original)
    }
    overlay.appendChild(row)
  })
  overlay.hidden = !captionsVisible || !lines.length
}

function setCaptionsVisible(visible) {
  captionsVisible = visible
  const button = $('#ccButton')
  button.classList.toggle('active', visible)
  button.setAttribute('aria-pressed', String(visible))
  clearInterval(overlayTimer)
  if (visible) overlayTimer = setInterval(renderOverlay, 1000)
  renderOverlay()
}

async function toggleCaptions() {
  if (captionsVisible) return setCaptionsVisible(false)
  const button = $('#ccButton')
  button.disabled = true
  try {
    await ensureTranscription()
    setCaptionsVisible(true)
    if (!captionPrefs.speaking) toast('Captions on. Set the language you speak in Transcript for better accuracy.', 'info')
  } catch (error) {
    console.log('captions error', error)
    toast('Captions: ' + describeError(error))
  } finally {
    button.disabled = false
  }
}

function downloadTranscript() {
  if (!transcript.length) return toast('The transcript is empty so far', 'info')
  const info = zmClient.getSessionInfo ? zmClient.getSessionInfo() : {}
  const lines = ['Transcript — ' + (info.topic || 'session') + ' — ' + new Date().toLocaleString(), '']
  transcript.forEach((e) => {
    lines.push('[' + formatTime(e.ts) + '] ' + e.name + ': ' + (e.text || e.translation))
    if (e.translation && e.text) lines.push('    → ' + e.translation)
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'transcript-' + String(info.topic || 'session').replace(/[^\w-]+/g, '_') + '-' + new Date().toISOString().slice(0, 10) + '.txt'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

// ---------- Hooks called from scripts.js ----------

function captionsOnJoin() {
  ltClient = zmClient.getLiveTranscriptionClient ? zmClient.getLiveTranscriptionClient() : null
  if (!ltClient) {
    show('#ccButton', false)
    show('#captionsButton', false)
    return
  }
  // If someone already started transcription, caption-message events arrive either way
  updateCaptionHostControls()
}

function captionsPanelOpened() {
  renderCaptionSettings()
  const list = $('#transcript-list')
  list.scrollTop = list.scrollHeight
}

function captionsReset() {
  ltClient = null
  transcriptionStarted = false
  transcript = []
  transcriptIndex.clear()
  overlayLines.clear()
  clearInterval(overlayTimer)
  captionsVisible = false
  const button = $('#ccButton')
  if (button) { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false') }
  $('#transcript-list').innerHTML = ''
  $('#caption-overlay').innerHTML = ''
  show('#caption-overlay', false)
}

// ---------- Events & wiring ----------

zmClient.on('caption-message', (payload) => {
  if (!zmStream || !features.has('captions')) return
  handleCaptionMessage(payload, false)
})

zmClient.on('caption-status', (payload) => {
  console.log('caption-status', payload)
  if (!zmStream || !ltClient) return
  const status = captionStatus()
  if (status.isHostDisableCaptions && captionsVisible) {
    setCaptionsVisible(false)
    transcriptionStarted = false
    toast('The host turned off captions', 'info')
  }
  if (payload && payload.translationStarted && !captionPrefs.speaking) {
    toast('Translation is on. Set the language you speak in Transcript so others get accurate translations.', 'info')
  }
  if (payload && payload.sessionLanguage) {
    const lang = findLanguage(payload.sessionLanguage)
    toast('Session caption language changed to ' + (lang ? lang.name : payload.sessionLanguage), 'info')
  }
  if (openPanel === 'captions') renderCaptionSettings()
})

$('#ccButton').addEventListener('click', toggleCaptions)
$('#captionsButton').addEventListener('click', () => togglePanel('captions'))
$('#speakingLanguage').addEventListener('change', (e) => onSpeakingChange(e.target.value))
$('#translationLanguage').addEventListener('change', (e) => onTranslationChange(e.target.value))
$('#captionSize').addEventListener('change', (e) => { captionPrefs.size = e.target.value; saveCaptionPrefs(); renderOverlay() })
$('#captionShow').addEventListener('change', (e) => { captionPrefs.show = e.target.value; saveCaptionPrefs(); renderOverlay() })
$('#downloadTranscript').addEventListener('click', downloadTranscript)
$('#hostDisableCaptions').addEventListener('change', (e) => {
  const disable = e.target.checked
  Promise.resolve(ltClient && ltClient.disableCaptions(disable))
    .then((result) => {
      const err = resultError(result)
      if (err) throw err
      if (disable) { setCaptionsVisible(false); transcriptionStarted = false }
      toast(disable ? 'Captions turned off for everyone' : 'Captions allowed again', 'info')
    })
    .catch((error) => {
      e.target.checked = !disable
      toast('Could not change captions: ' + describeError(error))
    })
    .finally(() => setTimeout(renderCaptionSettings, 300))
})
