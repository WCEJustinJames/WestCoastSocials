// One-time helper: get a Google OAuth refresh token for the sync. Covers the
// Contacts (People API) sync AND read-only access to the TD-sheet Google Sheets
// (find them by name in Drive, read the attendee columns). Put GOOGLE_CLIENT_ID
// and GOOGLE_CLIENT_SECRET in your .env first, then from the wce-unified-inbox
// folder run:
//
//   node scripts/get-google-refresh-token.mjs
//
// It opens a local consent flow (sign in as the Google account that OWNS the
// contacts + TD sheets) and prints the GOOGLE_REFRESH_TOKEN line for your .env.
// Re-run this whenever the scopes below change (you'll be asked to re-approve).
import 'dotenv/config'
import http from 'node:http'

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const PORT = 53682
const redirectUri = `http://localhost:${PORT}`
// contacts.readonly      — the People API contacts sync (existing)
// drive.metadata.readonly — find tonight's TD sheet by name/folder (metadata only,
//                           NOT file contents — can't read other Drive files)
// spreadsheets.readonly   — read the attendee columns out of that one sheet
const SCOPE = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
].join(' ')

if (!clientId || !clientSecret) {
  console.error('\n❌ Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env first, then re-run.\n')
  process.exit(1)
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', clientId)
authUrl.searchParams.set('redirect_uri', redirectUri)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPE)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

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
      console.log('\n✅ Success. Add this line to your .env:\n')
      console.log(`GOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`)
    } else {
      res.end('No refresh token returned — check the terminal.')
      console.error('\n❌ No refresh_token in response (re-run and make sure you approve):\n', j, '\n')
    }
  } catch (e) {
    res.end('Error exchanging code — check the terminal.')
    console.error(e)
  } finally {
    server.close()
    setTimeout(() => process.exit(0), 200)
  }
})

server.listen(PORT, () => {
  console.log('\n1) Open this URL in your browser (sign in as the contacts account):\n')
  console.log('   ' + authUrl.toString())
  console.log("\n2) Approve access. You'll be redirected back here and the token prints below.\n")
})
