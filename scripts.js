const VideoSDK = window.WebVideoSDK.default
// Video_90P=0, 180P=1, 360P=2, 720P=3 (720p is the max a web client can render)
const VideoQuality = window.WebVideoSDK.VideoQuality || { Video_360P: 2, Video_720P: 3 }

let zmClient = VideoSDK.createClient()
let zmStream
let recordingClient
let audioDecode
let audioEncode

// IMPORTANT: point this at YOUR OWN deployment of https://github.com/zoom/videosdk-sample-signature-node.js
// Recording is billed to and stored in the Video SDK account that owns the SDK key used to sign the JWT.
// Zoom's public demo endpoint below signs with Zoom's key, so recording won't work / won't land in your account.
let signatureEndpoint = 'https://videosdk-auth-2.vercel.app/'
let sessionName = ''
let sessionPasscode = ''
let userName = 'Participant' + Math.floor(Math.random() * 100)
let role = 1
let userIdentity
let sessionKey

// Users whose video is currently attached, so we never attach twice or detach something that isn't there
const attached = new Set()
// Serialize attach/detach per user so a fast Start -> Stop -> Start can't run out of order
const pending = new Map()

const videoContainer = () => document.querySelector('#video-container')

// 'speaker' = active speaker large with thumbnails, 'gallery' = equal-sized grid
let currentView = 'speaker'
let activeSpeakerId = null

// Network quality per user: { userId: { uplink, downlink } }, levels 0-5
const networkQuality = new Map()
// Latest QoS samples, keyed by send/receive direction
const stats = { videoSend: null, videoReceive: null, audioSend: null, audioReceive: null }
let statsOpen = false

// enforceMultipleVideos: lets the WebAssembly renderer show more than one video without
// SharedArrayBuffer (GitHub Pages can't send COOP/COEP headers, and the old origin-trial token expired in March 2024)
zmClient.init('en-US', 'Global', {
  patchJsMedia: true,
  enforceMultipleVideos: true,
  leaveOnPageUnload: true
})

function getSignature() {
  document.querySelector('#getSignature').textContent = 'Joining Session...'
  document.querySelector('#getSignature').disabled = true
  document.querySelector('#error').style.display = 'none'

  fetch(signatureEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionName: document.getElementById('sessionName').value || sessionName,
      role: parseInt(document.getElementById('role').value, 10), // 1 = host, 0 = participant (must be a number)
      userIdentity: userIdentity,
      sessionKey: sessionKey,
      cloudRecordingOption: 1,   // 1 = separate video file per user (plus the combined recording)
      cloudRecordingElection: 1  // 1 = record this user's own video individually
    })
  }).then((response) => response.json())
    .then((data) => {
      if (!data.signature) throw new Error('Signature endpoint error: ' + JSON.stringify(data))
      logTokenRecordingFields(data.signature)
      joinSession(data.signature)
    })
    .catch((error) => {
      console.log(error)
      resetJoinButton()
    })
}

// Prints the recording-related claims actually inside the JWT, so you can confirm
// the signature endpoint is really setting them (per-user recording needs both = 1,
// and cloud_recording_option only takes effect on the HOST's token, role_type 1)
function logTokenRecordingFields(signature) {
  try {
    const part = signature.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)))
    console.table({
      role_type: payload.role_type,
      cloud_recording_option: payload.cloud_recording_option,
      cloud_recording_election: payload.cloud_recording_election
    })
    if (payload.cloud_recording_option !== 1 || payload.cloud_recording_election !== 1) {
      console.warn('Token is missing cloud_recording_option: 1 and/or cloud_recording_election: 1 — redeploy the signature endpoint')
    }
  } catch (e) {
    console.log('Could not decode token', e)
  }
}

function resetJoinButton() {
  document.querySelector('#getSignature').textContent = 'Join Session'
  document.querySelector('#getSignature').disabled = false
}

function joinSession(signature) {
  zmClient.join(
    document.getElementById('sessionName').value || sessionName,
    signature,
    document.getElementById('userName').value || userName,
    document.getElementById('sessionPasscode').value || sessionPasscode
  ).then(() => {
    zmStream = zmClient.getMediaStream()
    console.log(zmClient.getSessionInfo())

    if (zmClient.getAllUser().length > 4) {
      document.querySelector('#error').style.display = 'block'
      setTimeout(() => { zmClient.leave(); resetToLanding('Session full, join another.') }, 1000)
      return
    }

    document.querySelector('#session').style.display = 'flex'
    document.querySelector('#landing').style.display = 'none'

    // Render anyone who already had video on before we joined
    renderExistingVideos()

    subscribeStatistics()

    recordingClient = zmClient.getRecordingClient()
    updateRecordingUI()
    updateHostUI()
    const diag = recordingDiagnostics()
    if (diag.isHost && diag.canStartRecording === false) {
      toast('Cloud recording is not enabled for the Video SDK account that signed this session.')
    }
  }).catch((error) => {
    console.log(error)
    resetJoinButton()
  })
}

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

// ---------- Layout: speaker view / gallery view ----------

function setView(view) {
  currentView = view === 'gallery' ? 'gallery' : 'speaker'
  const select = document.querySelector('#viewMode')
  if (select && select.value !== currentView) select.value = currentView
  applyLayout()
}

function applyLayout() {
  const players = [...videoContainer().children]
  document.body.classList.toggle('gallery', currentView === 'gallery')
  document.body.classList.toggle('speaker', currentView === 'speaker')
  document.body.classList.toggle('one-tile', players.length < 2)

  // Who gets the big tile in speaker view: the active speaker, else the first
  // remote video, else yourself
  const selfId = zmStream ? zmClient.getCurrentUserInfo().userId : null
  const ids = players.map((p) => parseInt(p.getAttribute('node-id'), 10))
  let bigId = ids.includes(activeSpeakerId) ? activeSpeakerId : null
  if (bigId === null) bigId = ids.find((id) => id !== selfId)
  if (bigId === undefined || bigId === null) bigId = ids[0]

  players.forEach((player) => {
    const id = parseInt(player.getAttribute('node-id'), 10)
    player.classList.toggle('active-speaker', id === bigId)
  })

  // The waiting message only shows while nothing is being rendered
  const message = document.querySelector('#stage-message')
  message.style.display = players.length ? 'none' : 'block'
}

function renderExistingVideos() {
  const selfId = zmClient.getCurrentUserInfo().userId
  zmClient.getAllUser().forEach((user) => {
    if (user.bVideoOn && (user.userId !== selfId || zmStream.isCapturingVideo())) {
      attachUser(user.userId, peerQuality())
    }
  })
}

function startVideo() {
  document.querySelector('#startVideo').textContent = 'Starting Video...'
  document.querySelector('#startVideo').disabled = true

  const hd = zmStream.isSupportHDVideo ? zmStream.isSupportHDVideo() : false

  zmStream.startVideo({ mirrored: true, hd: hd })
    .then(() => attachUser(zmClient.getCurrentUserInfo().userId, hd ? VideoQuality.Video_720P : VideoQuality.Video_360P))
    .then(() => {
      document.querySelector('#startVideo').style.display = 'none'
      document.querySelector('#stopVideo').style.display = 'inline-block'
    })
    .catch((error) => console.log(error))
    .finally(() => {
      document.querySelector('#startVideo').textContent = 'Start Video'
      document.querySelector('#startVideo').disabled = false
    })
}

function stopVideo() {
  const selfId = zmClient.getCurrentUserInfo().userId
  zmStream.stopVideo()
    .then(() => detachUser(selfId))
    .catch((error) => console.log(error))

  document.querySelector('#startVideo').style.display = 'inline-block'
  document.querySelector('#stopVideo').style.display = 'none'
}

function startAudio() {
  var isSafari = window.safari !== undefined

  if (isSafari && !(audioDecode && audioEncode)) {
    console.log('desktop safari audio init has not finished')
    return
  }
  zmStream.startAudio()
  document.querySelector('#startAudio').style.display = 'none'
  document.querySelector('#muteAudio').style.display = 'inline-block'
}

function muteAudio() {
  zmStream.muteAudio()
  document.querySelector('#muteAudio').style.display = 'none'
  document.querySelector('#unmuteAudio').style.display = 'inline-block'
}

function unmuteAudio() {
  zmStream.unmuteAudio()
  document.querySelector('#muteAudio').style.display = 'inline-block'
  document.querySelector('#unmuteAudio').style.display = 'none'
}

// ---------- Network quality & QoS statistics ----------
// Docs: https://developers.zoom.us/docs/video-sdk/web/quality/
// Levels: 0-1 poor, 2 normal, 3-5 good. A score needs at least two users with video on.

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

// Your own pill: shows the weaker of your uplink and downlink
function updateNetworkIndicator() {
  const indicator = document.querySelector('#net-indicator')
  if (!zmStream) {
    indicator.style.display = 'none'
    return
  }
  const mine = networkQuality.get(zmClient.getCurrentUserInfo().userId) || {}
  const levels = [mine.uplink, mine.downlink].filter((l) => typeof l === 'number')
  indicator.style.display = 'flex'

  if (!levels.length) {
    indicator.className = ''
    document.querySelector('#net-label').textContent = 'Network: measuring…'
    indicator.querySelectorAll('#net-bars i').forEach((bar) => bar.classList.remove('on'))
    return
  }

  const worst = Math.min(...levels)
  indicator.className = qualityClass(worst)
  indicator.querySelectorAll('#net-bars i').forEach((bar, i) => bar.classList.toggle('on', i < Math.max(worst, 1)))
  document.querySelector('#net-label').textContent =
    `Network: ${qualityWord(worst)} (up ${mine.uplink ?? '–'} / down ${mine.downlink ?? '–'})`
}

// Each tile gets a coloured edge showing how that person's video is reaching you
function updateTileQuality(userId) {
  const player = videoContainer().querySelector(`video-player[node-id="${userId}"]`)
  if (!player) return
  const q = networkQuality.get(userId) || {}
  const selfId = zmClient.getCurrentUserInfo().userId
  // For other people, their uplink is what limits what you see
  const level = userId === selfId ? q.uplink : q.uplink ?? q.downlink
  player.classList.remove('net-good', 'net-normal', 'net-bad')
  const cls = qualityClass(level)
  if (cls) player.classList.add('net-' + cls)
  const user = zmClient.getUser ? zmClient.getUser(userId) : null
  if (user) player.title = `${user.displayName} — network ${qualityWord(level)}`
}

zmClient.on('network-quality-change', (payload) => {
  const entry = networkQuality.get(payload.userId) || {}
  entry[payload.type] = payload.level // 'uplink' or 'downlink'
  networkQuality.set(payload.userId, entry)

  if (payload.userId === zmClient.getCurrentUserInfo().userId) updateNetworkIndicator()
  updateTileQuality(payload.userId)
  if (statsOpen) renderStats()
})

// QoS samples: encoding true = what you send, false = what you receive
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

function line(label, d, extra) {
  if (!d) return `${label}: –`
  const bits = [`${Math.round((d.bitrate || 0) / 1000)} kbps`, `loss ${(d.avg_loss || 0).toFixed(1)}%`, `rtt ${Math.round(d.rtt || 0)} ms`, `jitter ${Math.round(d.jitter || 0)} ms`]
  return `${label}: ${extra ? extra(d) + ' · ' : ''}${bits.join(' · ')}`
}

function renderStats() {
  const mine = networkQuality.get(zmClient.getCurrentUserInfo().userId) || {}
  const levels = [mine.uplink, mine.downlink].filter((l) => typeof l === 'number')
  const res = (d) => `${d.width}x${d.height} @ ${Math.round(d.fps || 0)}fps`
  document.querySelector('#stats-body').textContent = [
    `Network  up ${mine.uplink ?? '–'} / down ${mine.downlink ?? '–'}  (${levels.length ? qualityWord(Math.min(...levels)) : 'measuring…'})`,
    '',
    line('Video sent', stats.videoSend, res),
    line('Video received', stats.videoReceive, res),
    line('Audio sent', stats.audioSend),
    line('Audio received', stats.audioReceive)
  ].join('\n')
}

function toggleStats() {
  statsOpen = !statsOpen
  document.querySelector('#stats-panel').style.display = statsOpen ? 'block' : 'none'
  if (statsOpen) renderStats()
}

// ---------- Cloud recording ----------
// Only the host or a manager can control recording, and the Video SDK account that owns
// the SDK key must have cloud recording enabled (Cloud Recording Storage Plan).

function isHostOrManager() {
  return !!(zmClient.isHost && zmClient.isHost()) || !!(zmClient.isManager && zmClient.isManager())
}

function canControlRecording() {
  return !!recordingClient && isHostOrManager() && recordingClient.canStartRecording()
}

// Call recordingDiagnostics() in the browser console to see why recording is or isn't available
function recordingDiagnostics() {
  const info = {
    signatureEndpoint: signatureEndpoint,
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

function toast(message, type) {
  const el = document.querySelector('#toast')
  el.textContent = message
  el.className = type || ''
  el.style.display = 'block'
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { el.style.display = 'none' }, 7000)
}

function setDisplay(id, show) {
  document.querySelector(id).style.display = show ? 'inline-block' : 'none'
}

function updateRecordingUI(state) {
  state = state || (recordingClient ? recordingClient.getCloudRecordingStatus() : 'Stopped')
  const isRecording = state === 'Recording'
  const isPaused = state === 'Paused'
  const controls = canControlRecording()

  setDisplay('#startRecording', controls && !isRecording && !isPaused)
  setDisplay('#pauseRecording', controls && isRecording)
  setDisplay('#resumeRecording', controls && isPaused)
  setDisplay('#stopRecording', controls && (isRecording || isPaused))

  // Everyone (not just the host) sees the notice while recording is on
  const indicator = document.querySelector('#recording-indicator')
  indicator.style.display = isRecording || isPaused ? 'flex' : 'none'
  indicator.classList.toggle('paused', isPaused)
  document.querySelector('#recording-label').textContent = isPaused ? 'PAUSED' : 'REC'
}

function recordingAction(buttonId, busyText, action) {
  const button = document.querySelector(buttonId)
  const original = button.textContent
  button.textContent = busyText
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
      alertRecordingError(error)
    })
    .finally(() => {
      button.textContent = original
      button.disabled = false
      updateRecordingUI()
    })
}

function alertRecordingError(error) {
  const reason = (error && (error.reason || error.message || error.type || JSON.stringify(error))) || 'Unknown error'
  toast('Recording failed: ' + reason)
}

function startRecording() {
  recordingAction('#startRecording', 'Starting...', () => recordingClient.startCloudRecording())
}

function pauseRecording() {
  recordingAction('#pauseRecording', 'Pausing...', () => recordingClient.pauseCloudRecording())
}

function resumeRecording() {
  recordingAction('#resumeRecording', 'Resuming...', () => recordingClient.resumeCloudRecording())
}

function stopRecording() {
  recordingAction('#stopRecording', 'Stopping...', () => recordingClient.stopCloudRecording())
}

// Individual (per-user) recording consent.
// When the host starts per-user recording, the SDK sends state 'Ask' to participants,
// who must accept or decline. The prompt is built here so no HTML changes are needed.
function showConsentPrompt() {
  if (document.querySelector('#recording-consent')) return
  const bar = document.createElement('div')
  bar.id = 'recording-consent'
  bar.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:30;' +
    'max-width:90vw;padding:20px 24px;border-radius:20px;background:#ffffff;color:#073B4C;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.35);text-align:center;font-size:15px'
  bar.innerHTML =
    '<p style="margin:0 0 14px">The host wants to record your video individually. Do you consent?</p>' +
    '<button class="primary" id="consent-accept">Accept</button>' +
    '<button class="leave" id="consent-decline">Decline</button>'
  document.body.appendChild(bar)

  const respond = (accept) => {
    bar.remove()
    const call = accept ? recordingClient.acceptIndividualRecording() : recordingClient.declineIndividualRecording()
    Promise.resolve(call)
      .then((result) => {
        if (result instanceof Error) throw result
        toast(accept ? 'You accepted individual recording' : 'You declined individual recording', 'info')
      })
      .catch((error) => alertRecordingError(error))
  }
  bar.querySelector('#consent-accept').onclick = () => respond(true)
  bar.querySelector('#consent-decline').onclick = () => respond(false)
}

function hideConsentPrompt() {
  const bar = document.querySelector('#recording-consent')
  if (bar) bar.remove()
}

// Fires for every participant whenever the recording state changes
zmClient.on('recording-change', (payload) => {
  console.log('recording-change', payload)
  if (payload.state === 'Ask') {
    showConsentPrompt()
    return
  }
  if (payload.state === 'Accept' || payload.state === 'Decline') {
    // Another user's consent response (host sees these) — just log it
    console.log('individual recording consent:', payload)
    return
  }
  hideConsentPrompt()
  updateRecordingUI(payload.state)
  if (payload.state === 'Recording') toast('Cloud recording is on', 'info')
  if (payload.state === 'Stopped') toast('Recording stopped — it will appear in your Video SDK account once processed', 'info')
})

// Host can change hands (e.g. host leaves) — show/hide the controls accordingly
zmClient.on('user-updated', () => {
  if (recordingClient) updateRecordingUI()
  if (zmStream) updateHostUI()
})

function clearAllVideo() {
  attached.clear()
  pending.clear()
  activeSpeakerId = null
  videoContainer().innerHTML = ''
  applyLayout()
}

// Leave: only you exit; the session keeps going for everyone else
function leaveSession() {
  zmClient.leave()
  resetToLanding()
}

// End: host only — closes the session for every participant
function endSession() {
  if (!zmClient.isHost()) {
    toast('Only the host can end the session for everyone')
    return
  }
  if (!confirmEnd()) return

  const button = document.querySelector('#endSession')
  button.textContent = 'Ending...'
  button.disabled = true

  zmClient.leave(true) // true = end the session for all users
    .catch((error) => console.log('end session error', error))
    .finally(() => {
      button.textContent = 'End Session for All'
      button.disabled = false
      resetToLanding()
    })
}

// Two-click confirm instead of window.confirm(), which some embedded browsers block
function confirmEnd() {
  const button = document.querySelector('#endSession')
  if (button.dataset.armed === 'true') {
    button.dataset.armed = 'false'
    return true
  }
  button.dataset.armed = 'true'
  button.textContent = 'Click again to end for all'
  setTimeout(() => {
    button.dataset.armed = 'false'
    button.textContent = 'End Session for All'
  }, 4000)
  return false
}

// Show the End button only to the host (host can change mid-session)
function updateHostUI() {
  const isHost = !!(zmClient.isHost && zmClient.isHost())
  document.querySelector('#endSession').style.display = isHost ? 'inline-block' : 'none'
}

// Shared UI cleanup for leave, end, and "host ended the session"
function resetToLanding(message) {
  clearAllVideo()
  networkQuality.clear()
  statsOpen = false
  document.querySelector('#stats-panel').style.display = 'none'
  zmStream = null
  recordingClient = null
  hideConsentPrompt()
  updateRecordingUI('Stopped')

  document.querySelector('#session').style.display = 'none'
  document.querySelector('#muteAudio').style.display = 'none'
  document.querySelector('#unmuteAudio').style.display = 'none'
  document.querySelector('#stopVideo').style.display = 'none'
  document.querySelector('#endSession').style.display = 'none'
  document.querySelector('#net-indicator').style.display = 'none'

  document.querySelector('#startVideo').style.display = 'inline-block'
  document.querySelector('#startAudio').style.display = 'inline-block'
  resetJoinButton()
  document.querySelector('#startVideo').textContent = 'Start Video'
  document.querySelector('#startVideo').disabled = false

  const error = document.querySelector('#error')
  if (message) {
    error.textContent = message
    error.style.display = 'block'
  } else {
    error.textContent = 'Session full, join another.'
    error.style.display = 'none'
  }

  document.querySelector('#landing').style.display = 'flex'
}

zmClient.on('media-sdk-change', (payload) => {
  console.log(payload)
  const { action, type, result } = payload
  if (type === 'audio' && result === 'success') {
    if (action === 'encode') audioEncode = true
    else if (action === 'decode') audioDecode = true
  }
})

// Replaces the old setInterval polling: act on the event directly, in order, once per user
zmClient.on('peer-video-state-change', (payload) => {
  if (!zmStream) return // joinSession() calls renderExistingVideos() once the stream is ready
  if (payload.userId === zmClient.getCurrentUserInfo().userId) return

  if (payload.action === 'Start') {
    attachUser(payload.userId, peerQuality())
  } else if (payload.action === 'Stop') {
    detachUser(payload.userId)
  }
})

// After a network drop the SDK reconnects, but the old video elements are dead — re-attach them
zmClient.on('connection-change', (payload) => {
  console.log('connection-change', payload)
  if (payload.state === 'Closed') {
    // Session ended by the host (or we were removed) — send everyone back to the join screen
    if (document.querySelector('#session').style.display !== 'none') {
      const ended = payload.reason === 'ended by host'
      resetToLanding(ended ? 'The host ended the session.' : 'You left the session.')
    }
    return
  }
  if (payload.state === 'Reconnecting') {
    clearAllVideo()
  } else if (payload.state === 'Connected' && zmStream) {
    zmStream = zmClient.getMediaStream()
    renderExistingVideos()
  }
})

// Zoom reports who is speaking; speaker view follows it
zmClient.on('video-active-change', (payload) => {
  if (payload.state === 'Active') {
    activeSpeakerId = payload.userId
    applyLayout()
  }
})

zmClient.on('user-added', () => applyLayout())

zmClient.on('user-removed', (payload) => {
  payload.forEach((user) => {
    if (attached.has(user.userId)) detachUser(user.userId)
  })
})

zmClient.on('active-share-change', (payload) => {
  console.log(payload)
})

setView('speaker')
