# Video SDK Playground

A vanilla-JS Zoom Video SDK (web, 2.5.0) sample modelled on the [UI Toolkit demo](https://sdk.zoom.com/videosdk-uitoolkit), built on the raw Video SDK instead of the toolkit. Anyone can bring their **own Video SDK key and secret** — no server needed.

## How auth works

The join screen offers three ways to get a token:

| Mode | What happens |
|---|---|
| **Key & secret** (default) | The JWT is signed **in the browser** with Web Crypto (HS256, see `jwt.js`). The secret is never sent anywhere; only the signed token goes to Zoom. "Remember on this device" saves the key/secret in that browser's localStorage — off by default. |
| **Signature endpoint** | POSTs `{ sessionName, role, sessionKey, userIdentity, cloudRecordingOption, cloudRecordingElection }` to your endpoint and expects `{ signature }` (same shape as [videosdk-auth-endpoint-sample](https://github.com/zoom/videosdk-auth-endpoint-sample)). |
| **Paste JWT** | Use a token generated elsewhere. |

After joining, the decoded token payload is shown on the join screen (with a Copy JWT button) — handy for checking `tpc`, `role_type` and the recording claims.

> In-browser signing is meant for developer testing with your own credentials. A production app must sign on a server so end users never see the SDK secret.

## Features (toggle on the join screen)

- Video with speaker / gallery view, camera preview before joining
- Audio with mute / unmute, kept in sync when the host mutes you
- Screen share (send and view)
- Chat — everyone or private messages, unread badge
- Participants — host can mute, make host, or remove
- Settings — camera / mic / speaker switching, background blur, mirror
- Cloud recording with per-user recording consent prompt (host/manager)
- Captions split button like the UI Toolkit: the CC icon toggles captions; the ^ opens a Captions menu (Speaking language, Translate captions to, View full transcript, Host caption control settings)
- Live captions on screen, with caption size and "original + translation" options
- Live transcript panel with Download .txt; late joiners load the transcript history
- Live translation: pick the language you speak and the language to translate captions into (35 languages; available pairs come from the account)
- Host can turn captions off for everyone and lock the speaking language
- Network quality indicator, per-tile quality borders, QoS stats overlay
- Leave, or end for all (host)
- Copy invite link (session name + passcode only — never credentials). Guests must sign with the same Video SDK key to land in the same session.

## Running it

It's static: `index.html`, `styles.css`, `scripts.js`, `jwt.js`, `captions.js`.

- **GitHub Pages**: push and enable Pages for the repo.
- **Locally**: `npx serve .` or `python3 -m http.server`, then open `http://localhost:…`.

Web Crypto requires a secure context, so use `https://` or `http://localhost` — opening the file directly (`file://`) won't sign tokens.

`enforceMultipleVideos: true` is set so several videos render without SharedArrayBuffer (GitHub Pages can't send COOP/COEP headers).

## Troubleshooting

- **Invalid signature**: make sure these are *Video SDK* credentials (not Meeting SDK / OAuth), the secret matches the key, and your clock is right.
- **Captions don't start**: live transcription must be enabled for the Video SDK account that signs the token, and translation is a separate add-on. The Captions menu and Transcript panel say which one is off.
- **Recording buttons missing**: you must be host/manager, the account must have cloud recording, and the Recording feature must be ticked. Run `recordingDiagnostics()` in the console.
