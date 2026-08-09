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
import dns from 'node:dns'
import { exec } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'

// Node 18+ resolves AAAA first and undici then hangs the full 10s connect
// timeout when the network has no working IPv6 route. On the club PC that
// showed up as `UND_ERR_CONNECT_TIMEOUT` against oauth2.googleapis.com while
// the same host loaded fine in a browser. Prefer A records.
dns.setDefaultResultOrder('ipv4first')

// Which .env key to write. Default is the work-account token, which is what
// TD sheets and the Gmail pull actually read; pass `contacts` for the personal
// account that holds the phone contacts.
const ENV_KEY = process.argv.includes('contacts') ? 'GOOGLE_REFRESH_TOKEN' : 'GOOGLE_REFRESH_TOKEN_WORK'

/**
 * Write the token straight into .env, replacing any existing line for this key.
 *
 * Copying it out of the terminal by hand is where this goes wrong: the value is
 * ~100 characters and wraps across two console lines, so a selection that looks
 * complete silently loses the tail, and Google answers `invalid_grant` with no
 * hint that the value is truncated. Pasting it over a neighbouring line is the
 * other way it goes wrong. Neither can happen if the script does the writing.
 */
function writeToEnv(token) {
  const file = '.env'
  if (!existsSync(file)) return { ok: false, reason: 'no .env file in this folder' }
  try {
    copyFileSync(file, '.env.bak')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let replaced = false
    const out = lines.map((line) => {
      if (line.startsWith(ENV_KEY + '=')) { replaced = true; return ENV_KEY + '=' + token }
      return line
    })
    if (!replaced) {
      if (out.length && out[out.length - 1].trim() !== '') out.push('')
      out.push(ENV_KEY + '=' + token)
    }
    writeFileSync(file, out.join('\n'))
    return { ok: true, replaced }
  } catch (e) {
    return { ok: false, reason: String(e.message || e) }
  }
}

console.log('\n=== WCE Google re-auth ===\n')

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const PORT = 53682
const redirectUri = `http://localhost:${PORT}`
// contacts.readonly       — the People API contacts sync
// drive.metadata.readonly — find tonight's TD sheet by name (metadata only)
// spreadsheets             — read attendees AND write JL transfer confirmations
//                            back into the sheets (upgraded from readonly)
// gmail.readonly          — unread inbox emails for the Home action queue
const SCOPE = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
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
      const w = writeToEnv(j.refresh_token)
      if (w.ok) {
        console.log(`\n✅ Success. ${w.replaced ? 'Updated' : 'Added'} ${ENV_KEY} in .env (previous file kept as .env.bak).`)
        console.log('   Nothing to copy. Close the sync window and run run-wce.bat.\n')
      } else {
        console.error(`\n⚠️  Got the token but could not write .env (${w.reason}).`)
        console.error('   Set this line by hand — it is ONE line, no spaces, no line break:\n')
        console.log(`${ENV_KEY}=${j.refresh_token}\n`)
      }
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
