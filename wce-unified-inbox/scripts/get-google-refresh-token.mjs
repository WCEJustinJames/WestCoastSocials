// One-time helper: get a Google OAuth refresh token for the sync (the Contacts
// sync AND read-only access to the TD-sheet Google Sheets). Run it from the
// wce-unified-inbox folder:
//
//   node scripts/get-google-refresh-token.mjs
//
// It writes (and tries to open) a "google-login.html" file that takes you to the
// Google sign-in. Sign in as the account that owns the contacts + TD sheets,
// approve, and the GOOGLE_REFRESH_TOKEN line prints in this terminal. Re-run
// whenever the scopes change (you'll be asked to re-approve).
import 'dotenv/config'
import http from 'node:http'
import { exec } from 'node:child_process'
import { writeFileSync } from 'node:fs'

console.log('\n=== WCE Google re-auth ===\n')

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const PORT = 53682
const redirectUri = `http://localhost:${PORT}`
// contacts.readonly       — the People API contacts sync
// drive.metadata.readonly — find tonight's TD sheet by name (metadata only)
// spreadsheets.readonly   — read the attendee columns out of that sheet
const SCOPE = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
].join(' ')

if (!clientId || !clientSecret) {
  console.error('❌ Could not read your Google credentials from .env.')
  console.error('   GOOGLE_CLIENT_ID found:    ', clientId ? 'yes' : 'NO')
  console.error('   GOOGLE_CLIENT_SECRET found:', clientSecret ? 'yes' : 'NO')
  console.error('\n   Fix: run this from the wce-unified-inbox folder (where .env lives), and make')
  console.error('   sure .env has GOOGLE_CLIENT_ID=... and GOOGLE_CLIENT_SECRET=... lines.\n')
  process.exit(1)
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', clientId)
authUrl.searchParams.set('redirect_uri', redirectUri)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPE)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')
const url = authUrl.toString()

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, redirectUri).searchParams.get('code')
  if (!code) {
    res.end('No authorization code received. Check the terminal.')
    return
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    const j = await r.json()
    if (j.refresh_token) {
      res.end('✅ Done! Close this tab and return to the terminal.')
      console.log('\n✅ Success. Replace the GOOGLE_REFRESH_TOKEN line in your .env with:\n')
      console.log(`GOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`)
    } else {
      res.end('No refresh token returned — check the terminal.')
      console.error('\n❌ No refresh_token in the response (re-run and make sure you approve):\n', j, '\n')
    }
  } catch (e) {
    res.end('Error exchanging code — check the terminal.')
    console.error(e)
  } finally {
    server.close()
    setTimeout(() => process.exit(0), 200)
  }
})

// If the port is held by an earlier attempt, say so clearly instead of dying silently.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use — an earlier login attempt is still running.`)
    console.error('   Close any other terminal/command windows running this script (or reboot the PC),')
    console.error('   then run it again.\n')
  } else {
    console.error('❌ Could not start the local login server:', e.message, '\n')
  }
  process.exit(1)
})

server.listen(PORT, () => {
  // Write a tiny HTML file that redirects straight to the Google sign-in, so you
  // can just open a file instead of copy-pasting a long URL out of the terminal.
  const safe = url.replace(/"/g, '&quot;')
  const html =
    `<!doctype html><meta charset="utf-8"><title>WCE Google login</title>` +
    `<meta http-equiv="refresh" content="0; url=${safe}">` +
    `<body style="font-family:sans-serif;padding:2rem">` +
    `<p>Redirecting to the Google sign-in…</p>` +
    `<p>If nothing happens, <a href="${safe}">click here to sign in</a>.</p></body>`
  try {
    writeFileSync('google-login.html', html)
  } catch {
    /* ignore — the URL below still works */
  }

  console.log('Sign in to Google to authorise the sync:\n')
  console.log('  → A file "google-login.html" was just created in this folder. Open it')
  console.log('    (double-click) — it takes you to the Google login.')
  console.log('    Sign in as justin.james@clubwestcoast.com.au and approve all permissions.\n')
  console.log('  → Or paste this URL into Chrome:\n')
  console.log('    ' + url + '\n')
  console.log('Waiting for you to approve…  (leave THIS window open)\n')

  // Best-effort auto-open of the html file (the filename is shell-safe).
  const opener =
    process.platform === 'win32'
      ? 'start "" "google-login.html"'
      : process.platform === 'darwin'
        ? 'open google-login.html'
        : 'xdg-open google-login.html'
  exec(opener, () => {})
})
