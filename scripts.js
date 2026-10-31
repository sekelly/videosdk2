// Video SDK Playground — a vanilla-JS take on the Zoom Video SDK UI Toolkit demo.
// Anyone can enter their own Video SDK key & secret; the JWT is signed in the browser (see jwt.js).
// Docs: https://developers.zoom.us/docs/video-sdk/web/

const VideoSDK = window.WebVideoSDK.default
// Video_90P=0, 180P=1, 360P=2, 720P=3 (720p is the max a web client can render)
const VideoQuality = window.WebVideoSDK.VideoQuality || { Video_360P: 2, Video_720P: 3 }

const STORAGE_PREFS = 'vsdk-playground-prefs'   // name, features, auth mode, endpoint (nothing secret)
const STORAGE_CREDS = 'vsdk-playground-creds'   // key + secret, only when "Remember" is ticked
const DEFAULT_ENDPOINT = 'https://videosdk-auth-2.vercel.app/'

const $ = (sel) => document.querySelector(sel)
const show = (sel, visible) => { const el = typeof sel === 'string' ? $(sel) : sel; if (el) el.hidden = !visible }

let zmClient = VideoSDK.createClient()
let zmStream = null
let recordingClient = null
let chatClient = null
let audioDecode = false
let audioEncode = false

let authMode = 'keys'
let features = new Set()
let lastToken = ''

// Users whose video is currently attached, so we never attach twice or detach something that isn't there
const attached = new Set()
// Serialize attach/detach per user so a fast Start -> Stop -> Start can't run out of order
const pending = new Map()
const videoContainer = () => $('#video-container')

// 'speaker' = active speaker large with thumbnails, 'gallery' = equal-sized grid
let currentView = 'speaker'
let activeSpeakerId = null

// Network quality per user: { userId: { uplink, downlink } }, levels 0-5
const networkQuality = new Map()
const stats = { videoSend: null, videoReceive: null, audioSend: null, audioReceive: null }
let statsOpen = false

// Screen share state
let mySharing = false
let viewingShareUserId = null

// Side panel + chat state
let openPanel = null
let unreadChats = 0

// Devices chosen before the matching media is started
const pendingDevices = { camera: null, mic: null, speaker: null }
let previewTrack = null
let previewOn = false

// enforceMultipleVideos: lets the WebAssembly renderer show more than one video without
// SharedArrayBuffer (GitHub Pages can't send COOP/COEP headers)
zmClient.init('en-US', 'Global', {
  patchJsMedia: true,
  enforceMultipleVideos: true,
  leaveOnPageUnload: true
})

// =====================================================================
// Join screen
// =====================================================================

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch (e) { return null }
}
function writeJSON(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* storage blocked */ }
}

function setAuthMode(mode) {
  authMode = mode
  document.querySelectorAll('#authMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode))
  document.querySelectorAll('.auth-pane').forEach((p) => { p.hidden = p.dataset.pane !== mode })
}

function selectedFeatures() {
  return new Set([...document.querySelectorAll('#features input:checked')].map((i) => i.value))
}

function loadLanding() {
  try { $('#sdkVersion').textContent = 'SDK ' + VideoSDK.VERSION } catch (e) { /* ignore */ }

  const prefs = readJSON(STORAGE_PREFS) || {}
  const creds = readJSON(STORAGE_CREDS)
  setAuthMode(prefs.authMode || 'keys')
  $('#userName').value = prefs.userName || ''
  $('#endpointUrl').value = prefs.endpoint || DEFAULT_ENDPOINT
  if (Array.isArray(prefs.features)) {
    document.querySelectorAll('#features input').forEach((i) => { i.checked = prefs.features.includes(i.value) })
  }
  if (creds) {
    $('#sdkKey').value = creds.key || ''
    $('#sdkSecret').value = creds.secret || ''
    $('#rememberCreds').checked = true
  }

  // Invite links prefill the session (never credentials)
  const params = new URLSearchParams(location.search)
  if (params.get('session')) $('#sessionName').value = params.get('session')
  if (params.get('pwd')) $('#sessionPasscode').value = params.get('pwd')
  if (params.get('name')) $('#userName').value = params.get('name')
  if (params.get('role') === '0') $('#role').value = '0'
  if (!$('#sessionName').value) $('#sessionName').value = 'playground-' + Math.random().toString(36).slice(2, 7)
}

function savePrefs() {
  writeJSON(STORAGE_PREFS, {
    authMode: authMode,
    userName: $('#userName').value.trim(),
    endpoint: $('#endpointUrl').value.trim(),
    features: [...selectedFeatures()]
  })
  if ($('#rememberCreds').checked) {
    writeJSON(STORAGE_CREDS, { key: $('#sdkKey').value.trim(), secret: $('#sdkSecret').value.trim() })
  } else {
    writeJSON(STORAGE_CREDS, null)
  }
}

function landingError(message) {
  const el = $('#error')
  el.textContent = message || ''
  el.style.display = message ? 'block' : 'none'
}

function setJoining(busy) {
  const button = $('#joinButton')
  button.disabled = busy
  button.textContent = busy ? 'Joining…' : 'Join session'
}

async function getToken(sessionName, role) {
  const userIdentity = $('#userIdentity').value.trim() || undefined
  const sessionKey = $('#sessionKey').value.trim() || undefined
  const perUser = $('#perUserRecording').checked && features.has('recording')

  if (authMode === 'keys') {
    return signVideoSdkJwt($('#sdkKey').value, $('#sdkSecret').value, {
      tpc: sessionName,
      role_type: role,
      user_identity: userIdentity,
      session_key: sessionKey,
      // Per-user recording only takes effect on the host's token
      cloud_recording_option: perUser ? 1 : undefined,
      cloud_recording_election: perUser ? 1 : undefined
    })
  }

  if (authMode === 'endpoint') {
    const url = $('#endpointUrl').value.trim()
    if (!url) throw new Error('Enter a signature endpoint URL.')
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: sessionName,
        role: role,
        userIdentity: userIdentity,
        sessionKey: sessionKey,
        cloudRecordingOption: perUser ? 1 : 0,
        cloudRecordingElection: perUser ? 1 : 0
      })
    })
    const data = await response.json().catch(() => ({}))
    if (!data.signature) throw new Error('Signature endpoint returned no signature (HTTP ' + response.status + ').')
    return data.signature
  }

  const pasted = $('#pastedJwt').value.trim()
  if (!pasted) throw new Error('Paste a Video SDK JWT.')
  return pasted
}

function showTokenPayload(token) {
  try {
    const payload = decodeJwtPayload(token)
    $('#tokenPayload').textContent = JSON.stringify(payload, null, 2)
    show('#tokenBox', true)
    return payload
  } catch (e) {
    $('#tokenPayload').textContent = 'Could not decode token'
    show('#tokenBox', true)
    return null
  }
}

function explainJoinError(error) {
  const reason = (error && (error.reason || error.message || error.type)) || 'Unknown error'
  const hints = []
  if (/signature|jwt|token|invalid/i.test(reason)) {
    hints.push('Check that you used Video SDK credentials (not Meeting SDK or OAuth), that the secret matches the key, and that your computer clock is correct.')
  }
  if (/passcode|password/i.test(reason)) hints.push('The passcode must match the one the first person joined with.')
  if (/tpc|topic|session name/i.test(reason)) hints.push('The token\'s tpc must equal the session name exactly.')
  return 'Could not join: ' + reason + (error && error.errorCode ? ' (code ' + error.errorCode + ')' : '') +
    (hints.length ? ' — ' + hints.join(' ') : '')
}

async function joinSession() {
  landingError('')
  const sessionName = $('#sessionName').value.trim()
  const userName = $('#userName').value.trim() || 'Guest ' + Math.floor(Math.random() * 100)
  const passcode = $('#sessionPasscode').value.trim()
  const role = parseInt($('#role').value, 10) // 1 = host, 0 = participant (must be a number)
  features = selectedFeatures()

  if (!sessionName) return landingError('Enter a session name.')
  savePrefs()
  setJoining(true)

  let token
  try {
    token = await getToken(sessionName, role)
    lastToken = token
    const payload = showTokenPayload(token)
    if (payload && payload.tpc && payload.tpc !== sessionName) {
      throw new Error('Token tpc "' + payload.tpc + '" does not match session name "' + sessionName + '".')
    }
  } catch (error) {
    console.log(error)
    setJoining(false)
    return landingError(error.message || String(error))
  }

  // Hand the camera from the preview to the session
  const previewCameraId = previewOn ? $('#previewCamera').value : null
  await stopPreview()

  try {
    await zmClient.join(sessionName, token, userName, passcode)
  } catch (error) {
    console.log('join error', error)
    setJoining(false)
    return landingError(explainJoinError(error))
  }

  zmStream = zmClient.getMediaStream()
  console.log('session info', zmClient.getSessionInfo())

  enterSession(sessionName)
  if (previewCameraId && features.has('video')) {
    pendingDevices.camera = previewCameraId
    startVideo()
  }
}

// ---------- Camera preview (before joining) ----------

async function listPreviewCameras() {
  try {
    const devices = await VideoSDK.getDevices()
    const cams = devices.filter((d) => d.kind === 'videoinput')
    const select = $('#previewCamera')
    const current = select.value
    select.innerHTML = ''
    cams.forEach((d, i) => select.add(new Option(d.label || 'Camera ' + (i + 1), d.deviceId)))
    if (current && cams.some((d) => d.deviceId === current)) select.value = current
  } catch (e) {
    console.log('getDevices failed', e)
  }
}

async function startPreview() {
  try {
    const video = $('#previewVideo')
    previewTrack = VideoSDK.createLocalVideoTrack($('#previewCamera').value || undefined)
    await previewTrack.start(video)
    previewOn = true
    show('#previewEmpty', false)
    $('#previewToggle').textContent = 'Stop preview'
    listPreviewCameras() // labels appear once permission is granted
  } catch (e) {
    console.log('preview failed', e)
    landingError('Camera preview failed: ' + (e.reason || e.message || e.name || e))
    previewTrack = null
  }
}

async function stopPreview() {
  if (previewTrack) {
    try { await previewTrack.stop() } catch (e) { /* ignore */ }
  }
  previewTrack = null
  previewOn = false
  show('#previewEmpty', true)
  $('#previewToggle').textContent = 'Preview camera'
}

// =====================================================================
// Entering / leaving the session
// =====================================================================

function enterSession(sessionName) {
  show('#landing', false)
  show('#session', true)
  $('#sessionTitle').textContent = sessionName

  // Hide controls for features that weren't selected
  document.querySelectorAll('[data-feature]').forEach((el) => { el.hidden = !features.has(el.dataset.feature) })
  if (!features.has('audio')) { show('#muteAudio', false); show('#unmuteAudio', false) }
  document.querySelectorAll('#panelTabs button').forEach((b) => { b.hidden = !features.has(b.dataset.panel) })

  setView(currentView)
  renderExistingVideos()
  subscribeStatistics()

  recordingClient = zmClient.getRecordingClient()
  chatClient = zmClient.getChatClient ? zmClient.getChatClient() : null
  updateRecordingUI()
  updateHostUI()
  refreshUsers()
  checkExistingShare()
  if (features.has('settings')) populateDevices()
  if (features.has('captions')) captionsOnJoin()

  const diag = recordingDiagnostics()
  if (features.has('recording') && diag.isHost && diag.canStartRecording === false) {
    toast('Cloud recording is not enabled for the Video SDK account that signed this session.')
  }
}

// Leave: only you exit; the session keeps going for everyone else
function leaveSession() {
  zmClient.leave().catch((e) => console.log(e))
  resetToLanding()
}

// End: host only — closes the session for every participant
function endSession() {
  if (!zmClient.isHost()) return toast('Only the host can end the session for everyone')
  if (!confirmEnd()) return
  const button = $('#endSession')
  button.textContent = 'Ending…'
  button.disabled = true
  zmClient.leave(true) // true = end the session for all users
    .catch((error) => console.log('end session error', error))
    .finally(() => {
      button.textContent = 'End for all'
      button.disabled = false
      resetToLanding()
    })
}

// Two-click confirm instead of window.confirm(), which some embedded browsers block
function confirmEnd() {
  const button = $('#endSession')
  if (button.dataset.armed === 'true') {
    button.dataset.armed = 'false'
    return true
  }
  button.dataset.armed = 'true'
  button.textContent = 'Click again'
  setTimeout(() => {
    button.dataset.armed = 'false'
    button.textContent = 'End for all'
  }, 4000)
  return false
}

function updateHostUI() {
  const isHost = !!(zmClient.isHost && zmClient.isHost())
  show('#endSession', isHost)
}

// Shared UI cleanup for leave, end, and "host ended the session"
function resetToLanding(message) {
  clearAllVideo()
  resetShareUI()
  networkQuality.clear()
  statsOpen = false
  show('#stats-panel', false)
  zmStream = null
  recordingClient = null
  chatClient = null
  audioDecode = audioEncode = false
  pendingDevices.camera = pendingDevices.mic = pendingDevices.speaker = null
  hideConsentPrompt()
  updateRecordingUI('Stopped')
  closePanel()
  captionsReset()
  $('#chat-list').innerHTML = ''
  unreadChats = 0
  updateChatBadge()

  show('#session', false)
  show('#muteAudio', false)
  show('#unmuteAudio', false)
  show('#stopVideo', false)
  show('#endSession', false)
  show('#net-indicator', false)
  show('#recording-indicator', false)
  show('#startVideo', true)
  show('#startAudio', true)
  $('#startVideo').disabled = false

  setJoining(false)
  landingError(message || '')
  show('#landing', true)
}

// =====================================================================
// Video
// =====================================================================

function peerQuality() {
  // Ask for 720p only when this browser can actually handle it; otherwise 360p keeps video smooth
  return zmStream && zmStream.isSupportHDVideo && zmStream.isSupportHDVideo()
    ? VideoQuality.Video_720P
    : VideoQuality.Video_360P
}

function queue(userId, task) {
  const prev = pending.get(userId) || Promise.resolve()
  const next = prev.then(task, task).catch((error) => console.log('video render error', userId, error))
  pending.set(userId, next)
  return next
}

function attachUser(userId, quality) {
  return queue(userId, async () => {
    if (!zmStream || attached.has(userId)) return
    const element = await zmStream.attachVideo(userId, quality || peerQuality())
    const user = zmClient.getUser ? zmClient.getUser(userId) : null
    if (user) element.title = user.displayName
    if (user) element.dataset.name = user.displayName
    videoContainer().appendChild(element)
    attached.add(userId)
    updateTileQuality(userId)
    applyLayout()
  })
}

function detachUser(userId) {
  return queue(userId, async () => {
    if (!zmStream || !attached.has(userId)) return
    const elements = await zmStream.detachVideo(userId)
    ;(Array.isArray(elements) ? elements : [elements]).forEach((el) => el && el.remove())
    attached.delete(userId)
    if (activeSpeakerId === userId) activeSpeakerId = null
    applyLayout()
  })
}

function renderExistingVideos() {
  const selfId = zmClient.getCurrentUserInfo().userId
  zmClient.getAllUser().forEach((user) => {
    if (user.bVideoOn && (user.userId !== selfId || zmStream.isCapturingVideo())) {
      attachUser(user.userId, peerQuality())
    }
  })
}

function clearAllVideo() {
  attached.clear()
  pending.clear()
  activeSpeakerId = null
  videoContainer().innerHTML = ''
  applyLayout()
}

function startVideo() {
  const button = $('#startVideo')
  button.disabled = true
  const hd = zmStream.isSupportHDVideo ? zmStream.isSupportHDVideo() : false
  const options = { mirrored: $('#mirrorToggle').checked, hd: hd }
  if (pendingDevices.camera) options.cameraId = pendingDevices.camera
  if ($('#blurToggle').checked && supportsBlur()) options.virtualBackground = { imageUrl: 'blur' }

  zmStream.startVideo(options)
    .then(() => attachUser(zmClient.getCurrentUserInfo().userId, hd ? VideoQuality.Video_720P : VideoQuality.Video_360P))
    .then(() => {
      show('#startVideo', false)
      show('#stopVideo', true)
      pendingDevices.camera = null
      if (features.has('settings')) populateDevices()
    })
    .catch((error) => {
      console.log(error)
      toast('Could not start video: ' + (error.reason || error.message || error.type || error))
    })
    .finally(() => { button.disabled = false })
}

function stopVideo() {
  const selfId = zmClient.getCurrentUserInfo().userId
  zmStream.stopVideo()
    .then(() => detachUser(selfId))
    .catch((error) => console.log(error))
  show('#startVideo', true)
  show('#stopVideo', false)
}

// ---------- Layout: speaker view / gallery view ----------

function setView(view) {
  currentView = view === 'gallery' ? 'gallery' : 'speaker'
  $('#viewLabel').textContent = currentView === 'gallery' ? 'Speaker' : 'Gallery'
  $('#viewToggle .ico').textContent = currentView === 'gallery' ? '🗣' : '▦'
  applyLayout()
}

function applyLayout() {
  const players = [...videoContainer().children]
  document.body.classList.toggle('gallery', currentView === 'gallery')
  document.body.classList.toggle('speaker', currentView === 'speaker')
  document.body.classList.toggle('one-tile', players.length < 2)
  document.body.classList.toggle('sharing', !$('#share-area').hidden)

  // Who gets the big tile in speaker view: the active speaker, else the first remote video, else yourself
  const selfId = zmStream ? zmClient.getCurrentUserInfo().userId : null
  const ids = players.map((p) => parseInt(p.getAttribute('node-id'), 10))
  let bigId = ids.includes(activeSpeakerId) ? activeSpeakerId : null
  if (bigId === null) bigId = ids.find((id) => id !== selfId)
  if (bigId === undefined || bigId === null) bigId = ids[0]

  players.forEach((player) => {
    const id = parseInt(player.getAttribute('node-id'), 10)
    player.classList.toggle('active-speaker', id === bigId)
  })

  $('#stage-message').style.display = players.length ? 'none' : 'block'
}

// =====================================================================
// Audio
// =====================================================================

function startAudio() {
  const isSafari = window.safari !== undefined
  if (isSafari && !(audioDecode && audioEncode)) {
    toast('Audio is still initialising in Safari — try again in a moment', 'info')
    return
  }
  const button = $('#startAudio')
  button.disabled = true
  Promise.resolve(zmStream.startAudio())
    .then(async () => {
      show('#startAudio', false)
      show('#muteAudio', true)
      try {
        if (pendingDevices.mic) await zmStream.switchMicrophone(pendingDevices.mic)
        if (pendingDevices.speaker) await zmStream.switchSpeaker(pendingDevices.speaker)
      } catch (e) { console.log('device switch failed', e) }
      pendingDevices.mic = pendingDevices.speaker = null
      if (features.has('settings')) populateDevices()
    })
    .catch((error) => {
      console.log(error)
      toast('Could not join audio: ' + (error.reason || error.message || error.type || error))
    })
    .finally(() => { button.disabled = false })
}

function muteAudio() {
  zmStream.muteAudio()
  show('#muteAudio', false)
  show('#unmuteAudio', true)
}

function unmuteAudio() {
  zmStream.unmuteAudio()
  show('#muteAudio', true)
  show('#unmuteAudio', false)
}

// Keep my mute buttons honest when the host mutes me or I'm unmuted remotely
function syncMyAudioButtons() {
  if (!zmStream) return
  const me = zmClient.getCurrentUserInfo()
  if (!me || !me.audio) return
  show('#startAudio', false)
  show('#muteAudio', !me.muted)
  show('#unmuteAudio', !!me.muted)
}

// =====================================================================
// Screen share
// Docs: https://developers.zoom.us/docs/video-sdk/web/share/
// =====================================================================

async function startShare() {
  if (!zmStream) return
  const useVideo = zmStream.isStartShareScreenWithVideoElement && zmStream.isStartShareScreenWithVideoElement()
  const element = useVideo ? $('#my-share-video') : $('#my-share-canvas')
  try {
    await zmStream.startShareScreen(element)
    mySharing = true
    await stopViewingShare() // only one share is shown at a time
    show(element, true)
    $('#share-label').textContent = 'You are sharing your screen'
    show('#share-area', true)
    show('#startShare', false)
    show('#stopShare', true)
    applyLayout()
  } catch (error) {
    console.log('share error', error)
    if (error && error.reason === 'required extension' && error.extensionUrl) {
      window.open(error.extensionUrl)
    } else if (!(error && /permission|denied|cancel/i.test(error.reason || error.message || ''))) {
      toast('Could not share: ' + ((error && (error.reason || error.message || error.type)) || error))
    }
  }
}

function stopShare() {
  if (zmStream && mySharing) zmStream.stopShareScreen().catch((e) => console.log(e))
  myShareStopped()
}

function myShareStopped() {
  mySharing = false
  show('#my-share-video', false)
  show('#my-share-canvas', false)
  show('#startShare', true)
  show('#stopShare', false)
  if (viewingShareUserId === null) show('#share-area', false)
  applyLayout()
  checkExistingShare()
}

async function viewShare(userId) {
  if (!zmStream || mySharing || viewingShareUserId === userId) return
  await stopViewingShare()
  viewingShareUserId = userId
  try {
    if (zmStream.attachShareView) {
      const element = await zmStream.attachShareView(userId)
      $('#share-container').appendChild(element)
    } else {
      show('#share-view-canvas', true)
      await zmStream.startShareView($('#share-view-canvas'), userId)
    }
    const user = zmClient.getUser ? zmClient.getUser(userId) : null
    $('#share-label').textContent = (user ? user.displayName : 'Someone') + ' is sharing'
    show('#share-area', true)
    applyLayout()
  } catch (error) {
    console.log('view share error', error)
    viewingShareUserId = null
  }
}

async function stopViewingShare() {
  if (viewingShareUserId === null) return
  const userId = viewingShareUserId
  viewingShareUserId = null
  try {
    if (zmStream && zmStream.detachShareView) {
      const elements = await zmStream.detachShareView(userId)
      ;(Array.isArray(elements) ? elements : [elements]).forEach((el) => el && el.remove && el.remove())
    } else if (zmStream && zmStream.stopShareView) {
      await zmStream.stopShareView()
    }
  } catch (error) {
    console.log('stop view share error', error)
  }
  $('#share-container').innerHTML = ''
  show('#share-view-canvas', false)
  if (!mySharing) show('#share-area', false)
  applyLayout()
}

function resetShareUI() {
  mySharing = false
  viewingShareUserId = null
  $('#share-container').innerHTML = ''
  ;['#share-view-canvas', '#my-share-video', '#my-share-canvas', '#share-area', '#stopShare'].forEach((s) => show(s, false))
  show('#startShare', features.has('share'))
}

// Someone may already be sharing when we join
function checkExistingShare() {
  if (!zmStream) return
  const selfId = zmClient.getCurrentUserInfo().userId
  let sharer = null
  try {
    if (zmStream.getActiveShareUserId) sharer = zmStream.getActiveShareUserId()
    if (!sharer) {
      const user = zmClient.getAllUser().find((u) => u.sharerOn && u.userId !== selfId)
      sharer = user ? user.userId : null
    }
  } catch (e) { /* ignore */ }
  if (sharer && sharer !== selfId) viewShare(sharer)
}

zmClient.on('active-share-change', (payload) => {
  console.log('active-share-change', payload)
  if (!zmStream) return
  const userId = payload.userId !== undefined ? payload.userId : payload.activeUserId
  if (userId === zmClient.getCurrentUserInfo().userId) return
  if (payload.state === 'Active') viewShare(userId)
  else if (payload.state === 'Inactive' && userId === viewingShareUserId) stopViewingShare()
})

zmClient.on('peer-share-state-change', (payload) => {
  if (!zmStream) return
  if (payload.action === 'Stop' && payload.userId === viewingShareUserId) stopViewingShare()
  refreshUsers()
})

// The browser's own "Stop sharing" bar was used
zmClient.on('passively-stop-share', () => myShareStopped())

// =====================================================================
// Side panel: chat / participants / settings
// =====================================================================

function togglePanel(name) {
  if (openPanel === name) return closePanel()
  openPanel = name
  show('#side-panel', true)
  document.querySelectorAll('#panelTabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name))
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name })
  ;['chat', 'users', 'settings', 'captions'].forEach((n) => $('#' + n + 'Button').classList.toggle('active', n === name))
  if (name === 'captions') captionsPanelOpened()
  if (name === 'chat') {
    unreadChats = 0
    updateChatBadge()
    refreshChatRecipients()
    setTimeout(() => $('#chat-text').focus(), 0)
  }
  if (name === 'users') refreshUsers()
  if (name === 'settings') populateDevices()
}

function closePanel() {
  openPanel = null
  show('#side-panel', false)
  ;['chat', 'users', 'settings', 'captions'].forEach((n) => $('#' + n + 'Button').classList.remove('active'))
}

// ---------- Chat ----------

function updateChatBadge() {
  const badge = $('#chatBadge')
  badge.textContent = unreadChats > 9 ? '9+' : String(unreadChats)
  badge.hidden = unreadChats === 0
}

function refreshChatRecipients() {
  if (!zmStream) return
  const select = $('#chat-to')
  const current = select.value
  const selfId = zmClient.getCurrentUserInfo().userId
  select.innerHTML = ''
  select.add(new Option('To: Everyone', 'all'))
  zmClient.getAllUser().filter((u) => u.userId !== selfId).forEach((u) => {
    select.add(new Option('To: ' + u.displayName + ' (privately)', String(u.userId)))
  })
  select.value = [...select.options].some((o) => o.value === current) ? current : 'all'
}

function addChatMessage({ name, text, mine, privateTo, time }) {
  const item = document.createElement('li')
  item.className = mine ? 'mine' : ''
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = (mine ? 'You' : name) + (privateTo ? ' → ' + privateTo + ' (private)' : '') +
    ' · ' + new Date(time || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const body = document.createElement('div')
  body.className = 'text'
  body.textContent = text
  item.append(meta, body)
  const list = $('#chat-list')
  list.appendChild(item)
  list.scrollTop = list.scrollHeight
}

function sendChat(event) {
  event.preventDefault()
  const input = $('#chat-text')
  const text = input.value.trim()
  if (!text || !chatClient) return
  const to = $('#chat-to').value
  const toName = to === 'all' ? null : $('#chat-to').selectedOptions[0].textContent.replace(/^To: /, '').replace(/ \(privately\)$/, '')
  const sending = to === 'all' ? chatClient.sendToAll(text) : chatClient.send(text, parseInt(to, 10))
  input.value = ''
  Promise.resolve(sending)
    .then(() => addChatMessage({ text: text, mine: true, privateTo: toName }))
    .catch((error) => {
      console.log('chat error', error)
      input.value = text
      toast('Message not sent: ' + (error.reason || error.message || error.type || error))
    })
}

zmClient.on('chat-on-message', (payload) => {
  if (!zmStream) return
  const selfId = zmClient.getCurrentUserInfo().userId
  if (payload.sender && payload.sender.userId === selfId) return // already shown when sent
  const isPrivate = payload.receiver && payload.receiver.userId === selfId
  addChatMessage({
    name: (payload.sender && payload.sender.name) || 'Someone',
    text: payload.message,
    privateTo: isPrivate ? 'you' : null,
    time: payload.timestamp
  })
  if (openPanel !== 'chat') {
    unreadChats++
    updateChatBadge()
  }
})

// ---------- Participants ----------

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('')
}

function refreshUsers() {
  if (!zmStream) return
  const users = zmClient.getAllUser()
  $('#userCount').textContent = users.length + (users.length === 1 ? ' participant' : ' participants')
  if (openPanel === 'chat') refreshChatRecipients()
  if (openPanel !== 'users') return

  const selfId = zmClient.getCurrentUserInfo().userId
  const amHost = zmClient.isHost()
  const list = $('#user-list')
  list.innerHTML = ''

  users.forEach((user) => {
    const item = document.createElement('li')
    const avatar = document.createElement('span')
    avatar.className = 'avatar'
    avatar.textContent = initials(user.displayName)

    const who = document.createElement('div')
    who.className = 'who'
    const name = document.createElement('strong')
    name.textContent = user.displayName + (user.userId === selfId ? ' (you)' : '')
    const tags = document.createElement('small')
    tags.textContent = [user.isHost ? 'Host' : '', user.isManager ? 'Manager' : ''].filter(Boolean).join(' · ')
    who.append(name, tags)

    const status = document.createElement('span')
    status.className = 'status'
    status.textContent = (user.sharerOn ? '🖥 ' : '') + (user.bVideoOn ? '📷 ' : '') +
      (user.audio ? (user.muted ? '🔇' : '🎤') : '')
    status.title = (user.audio ? (user.muted ? 'Muted' : 'Unmuted') : 'Not in audio') + (user.bVideoOn ? ', video on' : '')

    item.append(avatar, who, status)

    if (amHost && user.userId !== selfId) {
      const actions = document.createElement('span')
      actions.className = 'actions'
      if (user.audio && !user.muted) actions.appendChild(userAction('Mute', () => zmStream.muteAudio(user.userId)))
      actions.appendChild(userAction('Make host', () => zmClient.makeHost(user.userId)))
      actions.appendChild(userAction('Remove', () => zmClient.removeUser(user.userId)))
      item.appendChild(actions)
    }
    list.appendChild(item)
  })
}

function userAction(label, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ghost small'
  button.textContent = label
  button.onclick = () => {
    Promise.resolve().then(action)
      .then(() => setTimeout(refreshUsers, 300))
      .catch((error) => toast(label + ' failed: ' + (error.reason || error.message || error.type || error)))
  }
  return button
}

// ---------- Settings (devices, blur, mirror) ----------

function supportsBlur() {
  return !!(zmStream && zmStream.isSupportVirtualBackground && zmStream.isSupportVirtualBackground())
}

function fillSelect(select, devices, activeId, fallbackLabel) {
  select.innerHTML = ''
  if (!devices || !devices.length) {
    select.add(new Option('No ' + fallbackLabel.toLowerCase() + ' found', ''))
    select.disabled = true
    return
  }
  select.disabled = false
  devices.forEach((d, i) => select.add(new Option(d.label || fallbackLabel + ' ' + (i + 1), d.deviceId)))
  if (activeId && devices.some((d) => d.deviceId === activeId)) select.value = activeId
}

function populateDevices() {
  if (!zmStream) return
  try {
    fillSelect($('#cameraSelect'), zmStream.getCameraList(), pendingDevices.camera || zmStream.getActiveCamera(), 'Camera')
    fillSelect($('#micSelect'), zmStream.getMicList(), pendingDevices.mic || zmStream.getActiveMicrophone(), 'Microphone')
    fillSelect($('#speakerSelect'), zmStream.getSpeakerList(), pendingDevices.speaker || zmStream.getActiveSpeaker(), 'Speaker')
  } catch (e) {
    console.log('device list error', e)
  }
  show('#blurRow', supportsBlur())
  $('#settingsHint').textContent = zmStream.isCapturingVideo() ? '' : 'Camera labels appear after you allow camera/mic access.'
}

function switchDevice(kind, deviceId) {
  if (!zmStream || !deviceId) return
  const live = {
    camera: () => zmStream.isCapturingVideo(),
    mic: () => !!(zmClient.getCurrentUserInfo() || {}).audio,
    speaker: () => !!(zmClient.getCurrentUserInfo() || {}).audio
  }[kind]()
  if (!live) {
    pendingDevices[kind] = deviceId // applied when that media starts
    return
  }
  const call = { camera: 'switchCamera', mic: 'switchMicrophone', speaker: 'switchSpeaker' }[kind]
  Promise.resolve(zmStream[call](deviceId))
    .catch((error) => toast('Could not switch ' + kind + ': ' + (error.reason || error.message || error.type || error)))
}

function toggleBlur(on) {
  if (!zmStream || !zmStream.isCapturingVideo()) return // applied on next startVideo
  if (!supportsBlur()) return toast('Background blur is not supported in this browser')
  Promise.resolve(zmStream.updateVirtualBackgroundImage(on ? 'blur' : undefined))
    .catch((error) => toast('Blur failed: ' + (error.reason || error.message || error.type || error)))
}

function toggleMirror(on) {
  if (zmStream && zmStream.isCapturingVideo() && zmStream.mirrorVideo) {
    Promise.resolve(zmStream.mirrorVideo(on)).catch((e) => console.log(e))
  }
}

zmClient.on('device-change', () => {
  if (zmStream && openPanel === 'settings') populateDevices()
})

// =====================================================================
// Network quality & QoS statistics
// Docs: https://developers.zoom.us/docs/video-sdk/web/quality/
// Levels: 0-1 poor, 2 normal, 3-5 good. A score needs at least two users with video on.
// =====================================================================

function qualityClass(level) {
  if (typeof level !== 'number') return ''
  if (level <= 1) return 'bad'
  if (level === 2) return 'normal'
  return 'good'
}

function qualityWord(level) {
  const c = qualityClass(level)
  return c === 'good' ? 'Good' : c === 'normal' ? 'Normal' : c === 'bad' ? 'Poor' : 'Unknown'
}

function updateNetworkIndicator() {
  const indicator = $('#net-indicator')
  if (!zmStream) return show(indicator, false)
  const mine = networkQuality.get(zmClient.getCurrentUserInfo().userId) || {}
  const levels = [mine.uplink, mine.downlink].filter((l) => typeof l === 'number')
  show(indicator, true)

  if (!levels.length) {
    indicator.className = ''
    $('#net-label').textContent = 'Network: measuring…'
    indicator.querySelectorAll('#net-bars i').forEach((bar) => bar.classList.remove('on'))
    return
  }

  const worst = Math.min(...levels)
  indicator.className = qualityClass(worst)
  indicator.querySelectorAll('#net-bars i').forEach((bar, i) => bar.classList.toggle('on', i < Math.max(worst, 1)))
  $('#net-label').textContent = 'Network: ' + qualityWord(worst)
  indicator.title = 'Uplink ' + (mine.uplink ?? '–') + ' / downlink ' + (mine.downlink ?? '–') + ' (0–5)'
}

// Each tile gets a coloured edge showing how that person's video is reaching you
function updateTileQuality(userId) {
  const player = videoContainer().querySelector('video-player[node-id="' + userId + '"]')
  if (!player) return
  const q = networkQuality.get(userId) || {}
  const selfId = zmClient.getCurrentUserInfo().userId
  const level = userId === selfId ? q.uplink : q.uplink ?? q.downlink
  player.classList.remove('net-good', 'net-normal', 'net-bad')
  const cls = qualityClass(level)
  if (cls) player.classList.add('net-' + cls)
  const user = zmClient.getUser ? zmClient.getUser(userId) : null
  if (user) player.title = user.displayName + ' — network ' + qualityWord(level)
}

zmClient.on('network-quality-change', (payload) => {
  if (!zmStream) return
  const entry = networkQuality.get(payload.userId) || {}
  entry[payload.type] = payload.level // 'uplink' or 'downlink'
  networkQuality.set(payload.userId, entry)
  if (payload.userId === zmClient.getCurrentUserInfo().userId) updateNetworkIndicator()
  updateTileQuality(payload.userId)
  if (statsOpen) renderStats()
})

function subscribeStatistics() {
  try {
    zmStream.subscribeVideoStatisticData()
    zmStream.subscribeAudioStatisticData()
  } catch (error) {
    console.log('statistics subscribe failed', error)
  }
  updateNetworkIndicator()
}

function recordStat(kind, payload) {
  const data = payload && payload.data ? payload.data : payload
  if (!data) return
  stats[kind + (data.encoding ? 'Send' : 'Receive')] = data
  if (statsOpen) renderStats()
}

zmClient.on('video-statistic-data-change', (payload) => recordStat('video', payload))
zmClient.on('audio-statistic-data-change', (payload) => recordStat('audio', payload))

function statLine(label, d, extra) {
  if (!d) return label + ': –'
  const bits = [Math.round((d.bitrate || 0) / 1000) + ' kbps', 'loss ' + (d.avg_loss || 0).toFixed(1) + '%',
    'rtt ' + Math.round(d.rtt || 0) + ' ms', 'jitter ' + Math.round(d.jitter || 0) + ' ms']
  return label + ': ' + (extra ? extra(d) + ' · ' : '') + bits.join(' · ')
}

function renderStats() {
  if (!zmStream) return
  const mine = networkQuality.get(zmClient.getCurrentUserInfo().userId) || {}
  const levels = [mine.uplink, mine.downlink].filter((l) => typeof l === 'number')
  const res = (d) => d.width + 'x' + d.height + ' @ ' + Math.round(d.fps || 0) + 'fps'
  const info = zmClient.getSessionInfo()
  $('#stats-body').textContent = [
    'Session  ' + info.topic + '  (id ' + (info.sessionId || '–') + ')',
    'Network  up ' + (mine.uplink ?? '–') + ' / down ' + (mine.downlink ?? '–') + '  (' + (levels.length ? qualityWord(Math.min(...levels)) : 'measuring…') + ')',
    '',
    statLine('Video sent', stats.videoSend, res),
    statLine('Video received', stats.videoReceive, res),
    statLine('Audio sent', stats.audioSend),
    statLine('Audio received', stats.audioReceive)
  ].join('\n')
}

function toggleStats() {
  statsOpen = !statsOpen
  show('#stats-panel', statsOpen)
  $('#statsButton').classList.toggle('active', statsOpen)
  if (statsOpen) renderStats()
}

// =====================================================================
// Cloud recording
// Only the host or a manager can control recording, and the Video SDK account that owns
// the SDK key must have cloud recording enabled.
// =====================================================================

function isHostOrManager() {
  return !!(zmClient.isHost && zmClient.isHost()) || !!(zmClient.isManager && zmClient.isManager())
}

function canControlRecording() {
  return features.has('recording') && !!recordingClient && isHostOrManager() && recordingClient.canStartRecording()
}

// Call recordingDiagnostics() in the browser console to see why recording is or isn't available
function recordingDiagnostics() {
  const info = {
    authMode: authMode,
    isHost: !!(zmClient.isHost && zmClient.isHost()),
    isManager: !!(zmClient.isManager && zmClient.isManager()),
    canStartRecording: recordingClient ? recordingClient.canStartRecording() : 'no recording client',
    cloudRecordingStatus: recordingClient ? recordingClient.getCloudRecordingStatus() : 'no recording client',
    sessionInfo: zmClient.getSessionInfo()
  }
  console.table(info)
  return info
}
window.recordingDiagnostics = recordingDiagnostics

function updateRecordingUI(state) {
  state = state || (recordingClient ? recordingClient.getCloudRecordingStatus() : 'Stopped')
  const isRecording = state === 'Recording'
  const isPaused = state === 'Paused'
  const controls = canControlRecording()

  show('#startRecording', controls && !isRecording && !isPaused)
  show('#pauseRecording', controls && isRecording)
  show('#resumeRecording', controls && isPaused)
  show('#stopRecording', controls && (isRecording || isPaused))

  // Everyone (not just the host) sees the notice while recording is on
  const indicator = $('#recording-indicator')
  show(indicator, isRecording || isPaused)
  indicator.classList.toggle('paused', isPaused)
  $('#recording-label').textContent = isPaused ? 'Recording paused' : 'Recording'
}

function recordingAction(buttonId, action) {
  const button = $(buttonId)
  button.disabled = true
  Promise.resolve()
    .then(() => {
      if (!recordingClient) throw new Error('Not in a session')
      if (!isHostOrManager()) throw new Error('Only the host or a manager can control recording')
      return action()
    })
    .then((result) => {
      // These methods resolve with an Error object instead of rejecting in some cases
      if (result instanceof Error) throw result
    })
    .catch((error) => {
      console.log('recording error', error)
      toast('Recording failed: ' + ((error && (error.reason || error.message || error.type)) || 'Unknown error'))
    })
    .finally(() => {
      button.disabled = false
      updateRecordingUI()
    })
}

// Individual (per-user) recording consent: participants get state 'Ask' and must accept or decline
function showConsentPrompt() {
  if ($('#recording-consent')) return
  const box = document.createElement('div')
  box.id = 'recording-consent'
  box.innerHTML =
    '<p>The host wants to record your video individually. Do you consent?</p>' +
    '<button type="button" class="primary" id="consent-accept">Accept</button> ' +
    '<button type="button" class="leave" id="consent-decline">Decline</button>'
  document.body.appendChild(box)

  const respond = (accept) => {
    box.remove()
    const call = accept ? recordingClient.acceptIndividualRecording() : recordingClient.declineIndividualRecording()
    Promise.resolve(call)
      .then((result) => {
        if (result instanceof Error) throw result
        toast(accept ? 'You accepted individual recording' : 'You declined individual recording', 'info')
      })
      .catch((error) => toast('Recording failed: ' + (error.reason || error.message || error.type || error)))
  }
  box.querySelector('#consent-accept').onclick = () => respond(true)
  box.querySelector('#consent-decline').onclick = () => respond(false)
}

function hideConsentPrompt() {
  const box = $('#recording-consent')
  if (box) box.remove()
}

zmClient.on('recording-change', (payload) => {
  console.log('recording-change', payload)
  if (payload.state === 'Ask') return showConsentPrompt()
  if (payload.state === 'Accept' || payload.state === 'Decline') return
  hideConsentPrompt()
  updateRecordingUI(payload.state)
  if (payload.state === 'Recording') toast('Cloud recording is on', 'info')
  if (payload.state === 'Stopped') toast('Recording stopped — it will appear in the Video SDK account once processed', 'info')
})

// =====================================================================
// Session events
// =====================================================================

zmClient.on('user-added', () => { if (zmStream) { applyLayout(); refreshUsers() } })

zmClient.on('user-removed', (payload) => {
  if (!zmStream) return
  payload.forEach((user) => {
    if (attached.has(user.userId)) detachUser(user.userId)
    if (user.userId === viewingShareUserId) stopViewingShare()
  })
  refreshUsers()
})

// Host can change hands, people mute/unmute, etc.
zmClient.on('user-updated', () => {
  if (!zmStream) return
  if (features.has('captions')) updateCaptionHostControls()
  updateRecordingUI()
  updateHostUI()
  syncMyAudioButtons()
  refreshUsers()
})

zmClient.on('media-sdk-change', (payload) => {
  const { action, type, result } = payload
  if (type === 'audio' && result === 'success') {
    if (action === 'encode') audioEncode = true
    else if (action === 'decode') audioDecode = true
  }
})

zmClient.on('peer-video-state-change', (payload) => {
  if (!zmStream) return // enterSession() calls renderExistingVideos() once the stream is ready
  if (payload.userId === zmClient.getCurrentUserInfo().userId) return
  if (payload.action === 'Start') attachUser(payload.userId, peerQuality())
  else if (payload.action === 'Stop') detachUser(payload.userId)
  refreshUsers()
})

// After a network drop the SDK reconnects, but the old video elements are dead — re-attach them
zmClient.on('connection-change', (payload) => {
  console.log('connection-change', payload)
  if (payload.state === 'Closed') {
    if (!$('#session').hidden) {
      const ended = payload.reason === 'ended by host'
      const kicked = payload.reason === 'kicked by host'
      resetToLanding(ended ? 'The host ended the session.' : kicked ? 'The host removed you from the session.' : 'You left the session.')
    }
    return
  }
  if (payload.state === 'Reconnecting') {
    clearAllVideo()
    toast('Reconnecting…', 'info')
  } else if (payload.state === 'Connected' && zmStream) {
    zmStream = zmClient.getMediaStream()
    renderExistingVideos()
    checkExistingShare()
  }
})

// Zoom reports who is speaking; speaker view follows it
zmClient.on('video-active-change', (payload) => {
  if (payload.state === 'Active') {
    activeSpeakerId = payload.userId
    applyLayout()
  }
})

// =====================================================================
// Misc UI helpers + wiring
// =====================================================================

function toast(message, type) {
  const el = $('#toast')
  el.textContent = message
  el.className = type || ''
  el.style.display = 'block'
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { el.style.display = 'none' }, 7000)
}

function copyText(text, okMessage) {
  const done = () => toast(okMessage, 'info')
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy this:', text))
  } else {
    window.prompt('Copy this:', text)
  }
}

function copyInvite() {
  // Only the session name and passcode — never credentials
  const info = zmClient.getSessionInfo()
  const url = new URL(location.origin + location.pathname)
  url.searchParams.set('session', info.topic)
  if (info.password) url.searchParams.set('pwd', info.password)
  url.searchParams.set('role', '0')
  copyText(url.toString(), 'Invite link copied. Guests must sign with the same Video SDK key to land in this session.')
}

function wire() {
  // Join screen
  document.querySelectorAll('#authMode button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)))
  $('#toggleSecret').addEventListener('click', () => {
    const input = $('#sdkSecret')
    const hidden = input.type === 'password'
    input.type = hidden ? 'text' : 'password'
    $('#toggleSecret').textContent = hidden ? 'Hide' : 'Show'
  })
  $('#rememberCreds').addEventListener('change', (e) => { if (!e.target.checked) writeJSON(STORAGE_CREDS, null) })
  $('#joinButton').addEventListener('click', joinSession)
  document.querySelectorAll('#landing input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinSession() }))
  $('#previewToggle').addEventListener('click', () => (previewOn ? stopPreview() : startPreview()))
  $('#previewCamera').addEventListener('change', async () => { if (previewOn) { await stopPreview(); startPreview() } })
  $('#copyToken').addEventListener('click', () => lastToken && copyText(lastToken, 'JWT copied'))

  // Session controls
  $('#startAudio').addEventListener('click', startAudio)
  $('#muteAudio').addEventListener('click', muteAudio)
  $('#unmuteAudio').addEventListener('click', unmuteAudio)
  $('#startVideo').addEventListener('click', startVideo)
  $('#stopVideo').addEventListener('click', stopVideo)
  $('#startShare').addEventListener('click', startShare)
  $('#stopShare').addEventListener('click', stopShare)
  $('#chatButton').addEventListener('click', () => togglePanel('chat'))
  $('#usersButton').addEventListener('click', () => togglePanel('users'))
  $('#settingsButton').addEventListener('click', () => togglePanel('settings'))
  document.querySelectorAll('#panelTabs button').forEach((b) => b.addEventListener('click', () => togglePanel(b.dataset.panel)))
  $('#panelClose').addEventListener('click', closePanel)
  $('#viewToggle').addEventListener('click', () => setView(currentView === 'speaker' ? 'gallery' : 'speaker'))
  $('#startRecording').addEventListener('click', () => recordingAction('#startRecording', () => recordingClient.startCloudRecording()))
  $('#pauseRecording').addEventListener('click', () => recordingAction('#pauseRecording', () => recordingClient.pauseCloudRecording()))
  $('#resumeRecording').addEventListener('click', () => recordingAction('#resumeRecording', () => recordingClient.resumeCloudRecording()))
  $('#stopRecording').addEventListener('click', () => recordingAction('#stopRecording', () => recordingClient.stopCloudRecording()))
  $('#statsButton').addEventListener('click', toggleStats)
  $('#stats-close').addEventListener('click', toggleStats)
  $('#leaveSession').addEventListener('click', leaveSession)
  $('#endSession').addEventListener('click', endSession)
  $('#copyInvite').addEventListener('click', copyInvite)

  // Panels
  $('#chat-form').addEventListener('submit', sendChat)
  $('#cameraSelect').addEventListener('change', (e) => switchDevice('camera', e.target.value))
  $('#micSelect').addEventListener('change', (e) => switchDevice('mic', e.target.value))
  $('#speakerSelect').addEventListener('change', (e) => switchDevice('speaker', e.target.value))
  $('#blurToggle').addEventListener('change', (e) => toggleBlur(e.target.checked))
  $('#mirrorToggle').addEventListener('change', (e) => toggleMirror(e.target.checked))
}

wire()
loadLanding()
listPreviewCameras()
setView('speaker')
