// In-browser Video SDK JWT signing (HS256) using the Web Crypto API — no libraries, no server.
//
// The SDK secret never leaves this page: it is only used locally to compute the HMAC.
// That makes this fine for a developer/testing tool where people use THEIR OWN credentials,
// but a production app must still sign on a server so end users never see the secret.
//
// Token claims: https://developers.zoom.us/docs/video-sdk/auth/

const enc = new TextEncoder()

function base64url(bytes) {
  let binary = ''
  new Uint8Array(bytes).forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signVideoSdkJwt(sdkKey, sdkSecret, claims) {
  if (!sdkKey || !sdkSecret) throw new Error('Enter your Video SDK key and secret.')
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto is unavailable. Open this page over https:// or http://localhost (not file://).')
  }

  // Back-date iat slightly so a fast local clock doesn't produce a "token not yet valid" error
  const iat = Math.floor(Date.now() / 1000) - 30
  const payload = {
    app_key: sdkKey.trim(),
    version: 1,
    iat: iat,
    exp: iat + 60 * 60 * 2, // Video SDK accepts 30 minutes to 48 hours
    ...claims
  }
  const header = { alg: 'HS256', typ: 'JWT' }

  const signingInput = base64url(enc.encode(JSON.stringify(header))) + '.' +
    base64url(enc.encode(JSON.stringify(payload)))

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(sdkSecret.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput))
  return signingInput + '.' + base64url(signature)
}

// Decode (not verify) a JWT payload, for showing what's inside a token
function decodeJwtPayload(token) {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  const json = decodeURIComponent(escape(atob(part + '='.repeat((4 - part.length % 4) % 4))))
  return JSON.parse(json)
}
