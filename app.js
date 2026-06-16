// West Coast Socials — unified scheduling dashboard
// Single-page app, persisted to localStorage.

const STORAGE_KEY = 'wcs.state.v1';

const PLATFORMS = [
  { id: 'instagram', label: 'Instagram', handle: '@westcoastsocials' },
  { id: 'facebook',  label: 'Facebook',  handle: '/westcoastsocials' },
  { id: 'twitter',   label: 'X / Twitter', handle: '@wc_socials' },
  { id: 'tiktok',    label: 'TikTok',    handle: '@westcoastsocials' },
  { id: 'linkedin',  label: 'LinkedIn',  handle: '/company/wcs' },
  { id: 'youtube',   label: 'YouTube',   handle: '/@westcoastsocials' },
  { id: 'threads',   label: 'Threads',   handle: '@westcoastsocials' },
];

// Channels available in the unified inbox. Messenger is the integrated channel
// (wired through messenger.js); the others are stubbed for the prototype.
const INBOX_CHANNELS = [
  { id: 'messenger', label: 'Messenger',   integrated: true },
  { id: 'instagram', label: 'Instagram' },
  { id: 'twitter',   label: 'X / Twitter' },
];

/* ------------------------------- State ------------------------------- */

const defaultState = () => {
  const now = new Date();
  const iso = (d) => new Date(d).toISOString();
  const plus = (days, hours = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(now.getHours() + hours, 0, 0, 0);
    return iso(d);
  };

  const games = [
    { id: uid(), opponent: 'Seattle Storm FC', date: plus(2, 2), homeAway: 'home',
      venue: 'Pier 62 Stadium', sport: 'Soccer' },
    { id: uid(), opponent: 'Portland Pilots', date: plus(5, 4), homeAway: 'away',
      venue: 'Providence Park', sport: 'Soccer' },
    { id: uid(), opponent: 'LA Surge',        date: plus(9, 3), homeAway: 'home',
      venue: 'Pier 62 Stadium', sport: 'Soccer' },
    { id: uid(), opponent: 'Vancouver Tide',  date: plus(14, 2), homeAway: 'away',
      venue: 'BC Place',        sport: 'Soccer' },
  ];

  const assets = [
    { id: uid(), title: 'Matchday countdown template', source: 'canva',
      url: 'https://www.canva.com/design/DAF-matchday', previewUrl: '',
      tags: ['matchday', 'countdown'] },
    { id: uid(), title: 'Starting XI lineup card', source: 'canva',
      url: 'https://www.canva.com/design/DAF-lineup', previewUrl: '',
      tags: ['lineup', 'matchday'] },
    { id: uid(), title: 'Final score card', source: 'claude-design',
      url: 'https://claude.ai/design/final-score', previewUrl: '',
      tags: ['recap', 'score'] },
    { id: uid(), title: 'Hype reel storyboard', source: 'claude-design',
      url: 'https://claude.ai/design/hype-reel', previewUrl: '',
      tags: ['hype', 'video'] },
  ];

  const posts = [
    {
      id: uid(),
      caption: '3 days until we host Seattle Storm FC at the Pier! Who\'s coming? #WestCoastWay',
      scheduledAt: plus(1, -1),
      status: 'scheduled',
      platforms: ['instagram', 'facebook', 'twitter'],
      gameId: games[0].id,
      assetId: assets[0].id,
    },
    {
      id: uid(),
      caption: 'Lineup drop ⚡ — tap in for tonight\'s starting XI.',
      scheduledAt: plus(2, 0),
      status: 'scheduled',
      platforms: ['instagram', 'twitter', 'threads'],
      gameId: games[0].id,
      assetId: assets[1].id,
    },
    {
      id: uid(),
      caption: 'Full time on the road. Thanks for riding with us, West Coast.',
      scheduledAt: plus(5, 6),
      status: 'draft',
      platforms: ['instagram', 'facebook'],
      gameId: games[1].id,
      assetId: assets[2].id,
    },
    {
      id: uid(),
      caption: 'Behind the scenes of Saturday\'s hype reel 🎬',
      scheduledAt: plus(3, -2),
      status: 'scheduled',
      platforms: ['tiktok', 'youtube', 'instagram'],
      gameId: null,
      assetId: assets[3].id,
    },
    {
      id: uid(),
      caption: 'ICYMI: the goal of the month. Vote now in replies.',
      scheduledAt: plus(-2, 0),
      status: 'published',
      platforms: ['twitter', 'threads'],
      gameId: null,
      assetId: null,
    },
  ];

  const accounts = PLATFORMS.map((p) => ({ ...p, enabled: true }));

  // ---- Unified inbox seed: people we do outreach with, + their conversations ----
  const ago = (mins) => iso(new Date(now.getTime() - mins * 60000));

  const contacts = [
    { id: uid(), name: 'Maya Rodriguez', role: 'Player · Forward', hue: 330,
      channels: { messenger: '54100000001', instagram: '@maya.rod' }, tags: ['squad', 'first-team'] },
    { id: uid(), name: 'Jordan Lee', role: 'Player · Midfield', hue: 210,
      channels: { messenger: '54100000002' }, tags: ['squad', 'first-team'] },
    { id: uid(), name: 'Priya Nair', role: 'Recruit · Trialist', hue: 280,
      channels: { messenger: '54100000003', instagram: '@priya.plays' }, tags: ['recruit'] },
    { id: uid(), name: 'Dani Whitfield', role: 'Member · Parent', hue: 20,
      channels: { messenger: '54100000004' }, tags: ['youth', 'member'] },
    { id: uid(), name: 'Tom Becker', role: 'Season member', hue: 150,
      channels: { instagram: '@tombecker' }, tags: ['member'] },
    { id: uid(), name: 'Alex Okafor', role: 'Player · Keeper', hue: 95,
      channels: { messenger: '54100000006', twitter: '@okafor_gk' }, tags: ['squad', 'first-team'] },
    { id: uid(), name: 'Sofia Marchetti', role: 'Partner · Sponsor', hue: 255,
      channels: { messenger: '54100000007' }, tags: ['sponsor'] },
    { id: uid(), name: 'Ben Carter', role: 'Volunteer', hue: 185,
      channels: { twitter: '@bencarter' }, tags: ['volunteer'] },
  ];
  const C = {};
  contacts.forEach((c) => { C[c.name.split(' ')[0].toLowerCase()] = c.id; });

  const conversations = [
    { id: uid(), contactId: C.maya, channel: 'messenger', status: 'open', unread: true,
      messages: [
        { id: uid(), dir: 'in', text: 'Hey coach! Am I in the squad for Saturday vs Seattle Storm FC?', at: ago(38) },
      ] },
    { id: uid(), contactId: C.jordan, channel: 'messenger', status: 'open', unread: false,
      messages: [
        { id: uid(), dir: 'out', text: "Hi Jordan — checking availability for Saturday's home match. Good to start?", at: ago(180), status: 'read' },
        { id: uid(), dir: 'in',  text: "Yep I'm in 👍 what time's the warmup?", at: ago(168) },
        { id: uid(), dir: 'out', text: 'Meet at Pier 62 for 1pm, kickoff at 3.', at: ago(160), status: 'read' },
        { id: uid(), dir: 'in',  text: 'Perfect, see you there.', at: ago(152) },
      ] },
    { id: uid(), contactId: C.priya, channel: 'messenger', status: 'open', unread: true,
      messages: [
        { id: uid(), dir: 'out', text: 'Hi Priya, thanks for your interest in trialling with West Coast! Can you make our open session next Tuesday?', at: ago(1500), status: 'read' },
        { id: uid(), dir: 'in',  text: "Hi! Yes I'd love to. Where do I need to be and what should I bring?", at: ago(44) },
      ] },
    { id: uid(), contactId: C.dani, channel: 'messenger', status: 'snoozed', unread: false,
      messages: [
        { id: uid(), dir: 'in',  text: 'Hi, is U14 training still on this Thursday given the weather?', at: ago(620) },
        { id: uid(), dir: 'out', text: "Hi Dani — we'll confirm by Wednesday evening, keeping an eye on the forecast. I'll message you right here.", at: ago(600), status: 'read' },
      ] },
    { id: uid(), contactId: C.tom, channel: 'instagram', status: 'open', unread: true,
      messages: [
        { id: uid(), dir: 'in', text: 'Are there still tickets for the Pier match this weekend?', at: ago(95) },
      ] },
    { id: uid(), contactId: C.alex, channel: 'twitter', status: 'open', unread: false,
      messages: [
        { id: uid(), dir: 'out', text: 'Travel for the Portland away leg: coach leaves 8:30am Sat. You on it?', at: ago(300), status: 'read' },
        { id: uid(), dir: 'in',  text: 'On it. Gloves packed 🧤', at: ago(288) },
      ] },
    { id: uid(), contactId: C.sofia, channel: 'messenger', status: 'closed', unread: false,
      messages: [
        { id: uid(), dir: 'in',  text: 'Sharing the updated sponsor logo for the matchday graphics.', at: ago(4300) },
        { id: uid(), dir: 'out', text: "Got it, thank you! We'll feature it on the lineup card. Appreciate the partnership 🙌", at: ago(4280), status: 'read' },
      ] },
    { id: uid(), contactId: C.ben, channel: 'twitter', status: 'open', unread: true,
      messages: [
        { id: uid(), dir: 'in', text: 'Keen to help on matchday — anything you need volunteers for?', at: ago(210) },
      ] },
  ];

  return { posts, games, assets, accounts, contacts, conversations };
};

function uid() {
  return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // Backfill platforms list if it changes
    const accountIds = new Set((parsed.accounts || []).map((a) => a.id));
    for (const p of PLATFORMS) {
      if (!accountIds.has(p.id)) parsed.accounts.push({ ...p, enabled: true });
    }
    // Backfill the unified inbox for states saved before it existed.
    if (!Array.isArray(parsed.contacts) || !Array.isArray(parsed.conversations)) {
      const seed = defaultState();
      if (!Array.isArray(parsed.contacts)) parsed.contacts = seed.contacts;
      if (!Array.isArray(parsed.conversations)) parsed.conversations = seed.conversations;
    }
    return parsed;
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = load();

/* ------------------------------ Helpers ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const platformById = (id) => PLATFORMS.find((p) => p.id === id);
const gameById = (id) => state.games.find((g) => g.id === id);
const assetById = (id) => state.assets.find((a) => a.id === id);
const contactById = (id) => state.contacts.find((c) => c.id === id);
const channelById = (id) => INBOX_CHANNELS.find((c) => c.id === id);

// Inbox view state (selection + filters). Default to the Open queue.
let inboxState = { activeId: null, channel: 'all', status: 'open' };

const lastMessage = (conv) => conv.messages[conv.messages.length - 1];
const convTime = (conv) => { const m = lastMessage(conv); return m ? m.at : new Date(0).toISOString(); };
const unreadCount = () => state.conversations.filter((c) => c.unread && c.status !== 'closed').length;

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.round(h / 24);
  if (d < 7) return d + 'd';
  return formatDate(iso);
}
function channelBadge(id) {
  const c = channelById(id);
  return c ? `<span class="c-badge c-${id}">${c.label}</span>` : '';
}
function msgStatusLabel(s) {
  return s === 'read' ? 'Read'
    : s === 'delivered' ? 'Delivered'
    : s === 'failed' ? 'Failed'
    : s === 'sending' ? 'Sending…'
    : 'Sent';
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}
function toInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function platformBadge(id) {
  const p = platformById(id);
  if (!p) return '';
  return `<span class="p-badge p-${id}">${p.label}</span>`;
}

function statusChip(status) {
  return `<span class="status-chip status-${status}">${status}</span>`;
}

/* ------------------------------ Routing ------------------------------ */

function setView(view) {
  $$('.view').forEach((el) => el.classList.toggle('hidden', el.dataset.view !== view));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const titles = {
    overview: ['Overview', 'Everything scheduled across your pages, in one place.'],
    inbox: ['Unified inbox', 'Every player and member conversation, across all channels, in one place.'],
    schedule: ['Schedule queue', 'Filter, edit, and publish posts across every page.'],
    calendar: ['Calendar', 'Month view of scheduled posts and upcoming games.'],
    games: ['Games', 'Track fixtures and link posts to them automatically.'],
    assets: ['Asset library', 'Canva and Claude.ai/design assets, centralized.'],
    accounts: ['Accounts', 'Toggle which pages publish by default.'],
  };
  const [title, sub] = titles[view] || titles.overview;
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').textContent = sub;
  if (view === 'calendar') renderCalendar();
  if (view === 'inbox') renderInbox();
  if (view === 'schedule') renderPostsTable();
  if (view === 'games') renderGames();
  if (view === 'assets') renderAssets();
  if (view === 'accounts') { renderAccounts(); renderMessengerCard(); }
  if (view === 'overview') renderOverview();
}

/* ------------------------------ Overview ----------------------------- */

function renderOverview() {
  const now = Date.now();
  const sevenDays = now + 7 * 864e5;
  const fourteenDays = now + 14 * 864e5;
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const upcoming = state.posts
    .filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() >= now - 36e5)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  const scheduled7 = upcoming.filter((p) => new Date(p.scheduledAt).getTime() <= sevenDays).length;
  const publishedThisMonth = state.posts.filter((p) =>
    p.status === 'published' && new Date(p.scheduledAt).getTime() >= monthStart.getTime()
  ).length;
  const upcomingGames = state.games.filter((g) => {
    const t = new Date(g.date).getTime();
    return t >= now && t <= fourteenDays;
  });
  const activeAccounts = state.accounts.filter((a) => a.enabled).length;

  $('#statScheduled').textContent = scheduled7;
  $('#statPublished').textContent = publishedThisMonth;
  $('#statGames').textContent = upcomingGames.length;
  $('#statAccounts').textContent = activeAccounts;
  $('#statUnread').textContent = unreadCount();

  // Timeline
  const timeline = $('#upcomingTimeline');
  const next7 = upcoming.slice(0, 6);
  $('#upcomingCount').textContent = next7.length ? `${next7.length} posts queued` : 'Nothing scheduled';
  timeline.innerHTML = next7.length
    ? next7.map((p) => {
        const game = gameById(p.gameId);
        return `
          <div class="timeline-item" data-post-id="${p.id}">
            <div class="timeline-when">${formatDateTime(p.scheduledAt)}</div>
            <div>
              <div class="timeline-caption">${escapeHtml(p.caption)}</div>
              <div class="muted" style="font-size:11px;margin-top:4px;">
                ${game ? 'vs ' + escapeHtml(game.opponent) + ' · ' : ''}${statusChip(p.status)}
              </div>
            </div>
            <div class="badges">${p.platforms.map(platformBadge).join('')}</div>
          </div>
        `;
      }).join('')
    : `<div class="muted">No upcoming posts. Click "+ New Post" to start.</div>`;

  timeline.querySelectorAll('.timeline-item').forEach((el) => {
    el.addEventListener('click', () => openPostModal(el.dataset.postId));
  });

  // Game spotlight
  const spotlight = $('#gameSpotlight');
  spotlight.innerHTML = upcomingGames.length
    ? upcomingGames.slice(0, 4).map((g) => `
        <div class="spotlight-game">
          <h3>vs ${escapeHtml(g.opponent)}</h3>
          <div class="meta">
            ${formatDateTime(g.date)} · ${g.homeAway === 'home' ? 'Home' : 'Away'} ·
            ${escapeHtml(g.venue || '')} ${g.sport ? '· ' + escapeHtml(g.sport) : ''}
          </div>
        </div>
      `).join('')
    : `<div class="muted">No games in the next two weeks. Add one from the Games tab.</div>`;

  // Platform breakdown
  const counts = {};
  state.posts.filter((p) => p.status !== 'published').forEach((p) => {
    p.platforms.forEach((pid) => { counts[pid] = (counts[pid] || 0) + 1; });
  });
  const max = Math.max(1, ...Object.values(counts));
  const bars = $('#platformBars');
  bars.innerHTML = PLATFORMS.map((p) => {
    const n = counts[p.id] || 0;
    const w = Math.round((n / max) * 100);
    return `
      <div class="platform-bar">
        <div style="display:flex;gap:8px;align-items:center;">
          ${platformBadge(p.id)}
          <span class="muted" style="font-size:12px;">${escapeHtml(p.handle)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:var(--${p.id});"></div></div>
        <div style="text-align:right;font-size:12px;" class="muted">${n}</div>
      </div>
    `;
  }).join('');
}

/* ------------------------------- Queue ------------------------------- */

function renderPostsTable() {
  // populate filter options
  const filterPlatform = $('#filterPlatform');
  filterPlatform.innerHTML = `<option value="all">All</option>` +
    PLATFORMS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  const filterGame = $('#filterGame');
  filterGame.innerHTML = `<option value="all">All games</option>` +
    state.games.map((g) => `<option value="${g.id}">vs ${escapeHtml(g.opponent)}</option>`).join('');

  const status = $('#filterStatus').value;
  const platform = $('#filterPlatform').value;
  const game = $('#filterGame').value;
  const q = ($('#globalSearch').value || '').toLowerCase().trim();

  const filtered = state.posts
    .filter((p) => status === 'all' || p.status === status)
    .filter((p) => platform === 'all' || p.platforms.includes(platform))
    .filter((p) => game === 'all' || p.gameId === game)
    .filter((p) => !q || p.caption.toLowerCase().includes(q))
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  const table = $('#postsTable');
  if (!filtered.length) {
    table.innerHTML = `<div class="muted" style="padding:18px;">No posts match these filters.</div>`;
    return;
  }
  table.innerHTML = filtered.map((p) => {
    const g = gameById(p.gameId);
    const asset = assetById(p.assetId);
    return `
      <div class="post-row" data-post-id="${p.id}">
        <div class="post-when">${formatDateTime(p.scheduledAt)}</div>
        <div>
          <div class="post-caption clamp">${escapeHtml(p.caption)}</div>
          <div class="muted" style="font-size:11px;margin-top:4px;">
            ${g ? 'vs ' + escapeHtml(g.opponent) : 'No game'}
            ${asset ? ' · 🎨 ' + escapeHtml(asset.title) : ''}
          </div>
        </div>
        <div class="badges">${p.platforms.map(platformBadge).join('')}</div>
        <div>${statusChip(p.status)}</div>
        <div style="font-size:18px;color:var(--muted);">›</div>
      </div>
    `;
  }).join('');
  table.querySelectorAll('.post-row').forEach((el) => {
    el.addEventListener('click', () => openPostModal(el.dataset.postId));
  });
}

/* ------------------------------ Calendar ----------------------------- */

let calendarCursor = startOfMonth(new Date());

function startOfMonth(d) { const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }

function renderCalendar() {
  const cursor = calendarCursor;
  $('#calLabel').textContent = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const grid = $('#calendarGrid');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const firstDow = cursor.getDay();
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const prevDays = new Date(cursor.getFullYear(), cursor.getMonth(), 0).getDate();

  const today = new Date(); today.setHours(0,0,0,0);

  const cells = [];
  // previous month tail
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - 1, prevDays - i);
    cells.push({ date: d, out: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(cursor.getFullYear(), cursor.getMonth(), d), out: false });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const last = cells[cells.length - 1].date;
    const d = new Date(last); d.setDate(d.getDate() + 1);
    cells.push({ date: d, out: d.getMonth() !== cursor.getMonth() });
  }

  const header = dayNames.map((n) => `<div class="cal-day-name">${n}</div>`).join('');
  const body = cells.map(({ date, out }) => {
    const iso = date.toISOString().slice(0, 10);
    const dayPosts = state.posts.filter((p) => p.scheduledAt.slice(0, 10) === iso);
    const dayGames = state.games.filter((g) => g.date.slice(0, 10) === iso);
    const chips = [
      ...dayGames.map((g) => `
        <div class="cal-chip" title="Game vs ${escapeHtml(g.opponent)}">
          <span class="cal-dot" style="background:var(--warn);"></span>
          🏟 vs ${escapeHtml(g.opponent)}
        </div>
      `),
      ...dayPosts.slice(0, 3).map((p) => `
        <div class="cal-chip" data-post-id="${p.id}" title="${escapeHtml(p.caption)}">
          <span class="cal-dot" style="background:var(--${p.platforms[0] || 'accent'});"></span>
          ${escapeHtml(p.caption.slice(0, 34))}${p.caption.length > 34 ? '…' : ''}
        </div>
      `),
    ];
    if (dayPosts.length > 3) chips.push(`<div class="cal-more">+${dayPosts.length - 3} more</div>`);
    const isToday = date.getTime() === today.getTime();
    return `
      <div class="cal-day ${out ? 'out' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
        <div class="cal-date">${date.getDate()}</div>
        ${chips.join('')}
      </div>
    `;
  }).join('');

  grid.innerHTML = header + body;

  grid.querySelectorAll('.cal-chip[data-post-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openPostModal(el.dataset.postId);
    });
  });
  grid.querySelectorAll('.cal-day').forEach((el) => {
    el.addEventListener('click', () => {
      const d = new Date(el.dataset.date + 'T10:00');
      openPostModal(null, { scheduledAt: d.toISOString() });
    });
  });
}

/* ------------------------------- Games ------------------------------- */

function renderGames() {
  const list = $('#gamesList');
  const sorted = [...state.games].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!sorted.length) {
    list.innerHTML = `<div class="muted">No games yet. Add one above.</div>`;
    return;
  }
  list.innerHTML = sorted.map((g) => {
    const postCount = state.posts.filter((p) => p.gameId === g.id).length;
    return `
      <div class="game-card" data-game-id="${g.id}">
        <div class="badge-row">
          <span class="status-chip ha-${g.homeAway}">${g.homeAway.toUpperCase()}</span>
          ${g.sport ? `<span class="status-chip" style="background:var(--panel-2);color:var(--muted);">${escapeHtml(g.sport)}</span>` : ''}
        </div>
        <h3>vs ${escapeHtml(g.opponent)}</h3>
        <div class="muted" style="font-size:12px;">${formatDateTime(g.date)}</div>
        <div class="muted" style="font-size:12px;">${escapeHtml(g.venue || '')}</div>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
          <button class="btn-link" data-action="new-post">+ Post for this game</button>
          <span class="muted" style="font-size:11px;">${postCount} linked</span>
          <div style="flex:1"></div>
          <button class="btn-link" data-action="delete" style="color:var(--danger);">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.game-card').forEach((el) => {
    const id = el.dataset.gameId;
    el.querySelector('[data-action="new-post"]').addEventListener('click', () => {
      const g = gameById(id);
      openPostModal(null, { gameId: id, caption: `Matchday vs ${g.opponent} — `, scheduledAt: new Date(g.date).toISOString() });
    });
    el.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (!confirm('Delete this game? Linked posts will lose their game reference.')) return;
      state.games = state.games.filter((g) => g.id !== id);
      state.posts.forEach((p) => { if (p.gameId === id) p.gameId = null; });
      save(); renderGames(); renderOverview();
    });
  });
}

/* ------------------------------- Assets ------------------------------ */

function renderAssets() {
  const grid = $('#assetsGrid');
  if (!state.assets.length) {
    grid.innerHTML = `<div class="muted">No assets yet. Paste a Canva or Claude.ai/design URL above.</div>`;
    return;
  }
  grid.innerHTML = state.assets.map((a) => {
    const thumbStyle = a.previewUrl
      ? `style="background-image:url('${escapeAttr(a.previewUrl)}');"`
      : '';
    const sourceLabel = a.source === 'canva' ? 'Canva'
      : a.source === 'claude-design' ? 'Claude.ai/design'
      : 'Other';
    return `
      <div class="asset-card" data-asset-id="${a.id}">
        <div class="asset-thumb" ${thumbStyle}>${a.previewUrl ? '' : '🎨 preview'}</div>
        <div class="asset-body">
          <div class="asset-source">${sourceLabel}</div>
          <h4>${escapeHtml(a.title)}</h4>
          <div class="asset-tags">
            ${(a.tags || []).map((t) => `<span class="asset-tag">#${escapeHtml(t)}</span>`).join('')}
          </div>
          <div class="asset-actions">
            <a class="btn" href="${escapeAttr(a.url)}" target="_blank" rel="noopener">Open</a>
            <button class="btn" data-action="new-post">Use in post</button>
            <button class="btn" data-action="delete" style="color:var(--danger);">Delete</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.asset-card').forEach((el) => {
    const id = el.dataset.assetId;
    el.querySelector('[data-action="new-post"]').addEventListener('click', () => {
      openPostModal(null, { assetId: id });
    });
    el.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (!confirm('Delete this asset?')) return;
      state.assets = state.assets.filter((a) => a.id !== id);
      state.posts.forEach((p) => { if (p.assetId === id) p.assetId = null; });
      save(); renderAssets();
    });
  });
}

/* ------------------------------ Accounts ----------------------------- */

function renderAccounts() {
  const list = $('#accountsList');
  list.innerHTML = state.accounts.map((a) => `
    <div class="account-card">
      <div class="swatch" style="background:var(--${a.id});"></div>
      <div>
        <div class="label">${escapeHtml(a.label)}</div>
        <div class="sub">${escapeHtml(a.handle)}</div>
      </div>
      <label class="toggle">
        <input type="checkbox" ${a.enabled ? 'checked' : ''} data-account-id="${a.id}" />
      </label>
    </div>
  `).join('');
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.accountId;
      const acct = state.accounts.find((a) => a.id === id);
      acct.enabled = cb.checked;
      save(); renderSidebarAccounts(); renderOverview();
    });
  });
}

function renderSidebarAccounts() {
  $('#accountPills').innerHTML = state.accounts
    .map((a) => `<span class="pill ${a.enabled ? '' : 'off'}">${a.label}</span>`)
    .join('');
}

/* ------------------------------- Inbox ------------------------------- */

function renderInbox() {
  renderInboxFilters();
  renderConversationList();
  renderThread();
  updateInboxBadge();
}

function updateInboxBadge() {
  const badge = $('#inboxNavBadge');
  if (!badge) return;
  const n = unreadCount();
  badge.textContent = n || '';
  badge.classList.toggle('hidden', !n);
}

function renderInboxFilters() {
  const chanWrap = $('#inboxChannelFilter');
  const channels = [{ id: 'all', label: 'All channels' }, ...INBOX_CHANNELS];
  chanWrap.innerHTML = channels.map((c) => {
    const active = inboxState.channel === c.id ? ' active' : '';
    const dot = c.id === 'all' ? '' : `<span class="c-dot c-dot-${c.id}"></span>`;
    return `<button class="seg-btn${active}" data-channel="${c.id}">${dot}${escapeHtml(c.label)}</button>`;
  }).join('');
  chanWrap.querySelectorAll('[data-channel]').forEach((b) => {
    b.addEventListener('click', () => { inboxState.channel = b.dataset.channel; renderInbox(); });
  });

  const statusWrap = $('#inboxStatusFilter');
  const statuses = [['open', 'Open'], ['snoozed', 'Snoozed'], ['closed', 'Closed'], ['all', 'All']];
  statusWrap.innerHTML = statuses.map(([id, label]) => {
    const active = inboxState.status === id ? ' active' : '';
    return `<button class="seg-btn${active}" data-status="${id}">${label}</button>`;
  }).join('');
  statusWrap.querySelectorAll('[data-status]').forEach((b) => {
    b.addEventListener('click', () => { inboxState.status = b.dataset.status; renderInbox(); });
  });
}

function filteredConversations() {
  const q = ($('#globalSearch').value || '').toLowerCase().trim();
  return state.conversations
    .filter((c) => inboxState.channel === 'all' || c.channel === inboxState.channel)
    .filter((c) => inboxState.status === 'all' || c.status === inboxState.status)
    .filter((c) => {
      if (!q) return true;
      const contact = contactById(c.contactId);
      if (contact && contact.name.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => m.text.toLowerCase().includes(q));
    })
    .sort((a, b) => new Date(convTime(b)) - new Date(convTime(a)));
}

function renderConversationList() {
  const list = $('#conversationList');
  const convs = filteredConversations();
  if (!convs.length) {
    inboxState.activeId = null;
    list.innerHTML = `<div class="muted" style="padding:18px;">No conversations match these filters.</div>`;
    return;
  }
  // Keep the selection valid for the current filter set.
  if (!convs.some((c) => c.id === inboxState.activeId)) inboxState.activeId = convs[0].id;

  list.innerHTML = convs.map((c) => {
    const contact = contactById(c.contactId);
    const m = lastMessage(c);
    const preview = m ? (m.dir === 'out' ? 'You: ' : '') + m.text : '';
    const active = c.id === inboxState.activeId ? ' active' : '';
    const unread = c.unread ? ' unread' : '';
    return `
      <button class="conv-row${active}${unread}" data-conv-id="${c.id}">
        <span class="avatar" style="background:hsl(${contact ? contact.hue : 220} 50% 45%);">${initials(contact && contact.name)}</span>
        <span class="conv-main">
          <span class="conv-top">
            <span class="conv-name">${escapeHtml(contact ? contact.name : 'Unknown')}</span>
            <span class="conv-time">${relTime(convTime(c))}</span>
          </span>
          <span class="conv-sub">
            ${channelBadge(c.channel)}
            <span class="conv-preview">${escapeHtml(preview)}</span>
          </span>
        </span>
        ${c.unread ? '<span class="unread-dot"></span>' : ''}
      </button>`;
  }).join('');

  list.querySelectorAll('.conv-row').forEach((el) => {
    el.addEventListener('click', () => openConversation(el.dataset.convId));
  });
}

function openConversation(id) {
  inboxState.activeId = id;
  const conv = state.conversations.find((c) => c.id === id);
  if (conv && conv.unread) { conv.unread = false; save(); }
  renderInbox();
}

function renderThread() {
  const pane = $('#inboxThread');
  const conv = state.conversations.find((c) => c.id === inboxState.activeId);
  if (!conv) {
    pane.innerHTML = `<div class="thread-empty muted">Select a conversation to start the outreach.</div>`;
    return;
  }
  const contact = contactById(conv.contactId);
  const chan = channelById(conv.channel);
  const recipientId = contact && contact.channels ? contact.channels[conv.channel] : null;
  const isMessenger = conv.channel === 'messenger';
  const connected = window.Messenger ? Messenger.isConnected() : false;
  const gated = isMessenger && !connected;

  const bubbles = conv.messages.map((m) => {
    const ticks = m.dir === 'out'
      ? `<span class="msg-status s-${m.status || 'sent'}">${msgStatusLabel(m.status)}</span>` : '';
    return `
      <div class="bubble ${m.dir === 'out' ? 'out' : 'in'}" data-msg-id="${m.id}">
        <div class="bubble-text">${escapeHtml(m.text)}</div>
        <div class="bubble-meta">${relTime(m.at)} ${ticks}</div>
      </div>`;
  }).join('');

  const composer = gated
    ? `<div class="composer-gate">Facebook Messenger isn't connected.
         <button class="btn-link" data-act="go-connect">Connect it</button> to reply on this channel.</div>`
    : `<form class="composer" id="composerForm">
         <textarea name="text" rows="1" placeholder="Message ${escapeHtml(contact ? contact.name : '')} on ${escapeHtml(chan ? chan.label : conv.channel)}…" required></textarea>
         <button class="btn btn-primary" type="submit">Send</button>
       </form>`;

  pane.innerHTML = `
    <div class="thread-head">
      <span class="avatar" style="background:hsl(${contact ? contact.hue : 220} 50% 45%);">${initials(contact && contact.name)}</span>
      <div class="thread-who">
        <div class="thread-name">${escapeHtml(contact ? contact.name : 'Unknown')}</div>
        <div class="thread-sub">
          ${channelBadge(conv.channel)}
          <span class="muted">${escapeHtml(contact ? contact.role : '')}${recipientId ? ' · ' + escapeHtml(String(recipientId)) : ''}</span>
        </div>
      </div>
      <div class="thread-actions">
        ${statusBtn(conv, 'open', 'Open')}
        ${statusBtn(conv, 'snoozed', 'Snooze')}
        ${statusBtn(conv, 'closed', 'Close')}
        <button class="btn" data-act="unread" title="Mark as unread">Mark unread</button>
      </div>
    </div>
    <div class="thread-body" id="threadBody">${bubbles}</div>
    ${composer}
  `;

  pane.querySelectorAll('[data-status-set]').forEach((b) => {
    b.addEventListener('click', () => { conv.status = b.dataset.statusSet; save(); renderInbox(); });
  });
  const unreadBtn = pane.querySelector('[data-act="unread"]');
  if (unreadBtn) unreadBtn.addEventListener('click', () => { conv.unread = true; save(); renderInbox(); });
  const goConnect = pane.querySelector('[data-act="go-connect"]');
  if (goConnect) goConnect.addEventListener('click', () => setView('accounts'));

  const body = $('#threadBody');
  if (body) body.scrollTop = body.scrollHeight;

  const form = $('#composerForm');
  if (form) {
    const ta = form.querySelector('textarea');
    const submit = () => { const text = ta.value.trim(); if (text) sendMessage(conv, text); };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    // Enter sends, Shift+Enter inserts a newline (chat convention).
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
  }
}

// Update just one message's delivery status in place, so status ticks don't
// rebuild the thread (which would wipe a half-typed reply or steal focus).
function updateMsgStatusInDom(msg) {
  const el = document.querySelector(`.bubble[data-msg-id="${msg.id}"] .msg-status`);
  if (el) {
    el.textContent = msgStatusLabel(msg.status);
    el.className = `msg-status s-${msg.status || 'sent'}`;
  }
}

function statusBtn(conv, value, label) {
  const active = conv.status === value ? ' btn-active' : '';
  return `<button class="btn${active}" data-status-set="${value}">${label}</button>`;
}

function isInboxActive(conv) {
  return inboxState.activeId === conv.id
    && !$('.view[data-view="inbox"]').classList.contains('hidden');
}

// Append an outbound message and push it through the right channel. Messenger
// routes through messenger.js; other channels are simulated for the prototype.
function sendMessage(conv, text) {
  const contact = contactById(conv.contactId);
  const recipientId = contact && contact.channels ? contact.channels[conv.channel] : null;
  const msg = { id: uid(), dir: 'out', text, at: new Date().toISOString(), status: 'sending' };
  conv.messages.push(msg);
  conv.unread = false;
  if (conv.status === 'closed') conv.status = 'open';
  save();
  renderInbox();
  const composer = $('#composerForm');
  if (composer) composer.querySelector('textarea').focus();

  const refresh = () => { save(); if (isInboxActive(conv)) updateMsgStatusInDom(msg); };
  const onSent = () => {
    msg.status = 'sent';
    refresh();
    setTimeout(() => { msg.status = 'delivered'; refresh(); }, 700);
    setTimeout(() => { msg.status = 'read'; refresh(); }, 1800);
  };
  const onFail = (err) => {
    msg.status = 'failed';
    refresh();
    console.warn('Send failed:', (err && err.message) || err);
  };

  if (conv.channel === 'messenger' && window.Messenger) {
    Messenger.send({ recipientId, text }).then(onSent).catch(onFail);
  } else {
    setTimeout(onSent, 500); // stubbed channel
  }
}

/* ------------------------- Messaging channels ------------------------ */

function renderMessengerCard() {
  const wrap = $('#messengerCard');
  if (!wrap || !window.Messenger) return;
  const cfg = Messenger.getConfig();

  if (cfg.connected) {
    wrap.innerHTML = `
      <div class="channel-connected">
        <div class="channel-id">
          <span class="c-badge c-messenger">Messenger</span>
          <div>
            <div class="channel-page">${escapeHtml(cfg.pageName || 'Facebook Page')}</div>
            <div class="muted" style="font-size:12px;">
              Page ID ${escapeHtml(cfg.pageId)} · ${cfg.live ? 'LIVE (Graph API)' : 'Simulated'}
              ${cfg.connectedAt ? ' · connected ' + escapeHtml(formatDateTime(cfg.connectedAt)) : ''}
            </div>
          </div>
        </div>
        <div class="spacer"></div>
        <span class="status-chip status-published">Connected</span>
        <button class="btn" id="messengerDisconnect">Disconnect</button>
      </div>
      <p class="muted" style="font-size:12px;margin:10px 0 0;">
        Replies to Messenger conversations use the Graph Send API request shape. Simulated mode keeps
        everything in this browser; switch to live by supplying a real Page access token.
      </p>`;
    $('#messengerDisconnect').addEventListener('click', () => {
      if (!confirm("Disconnect Facebook Messenger? Conversations stay, but you won't be able to reply on this channel.")) return;
      Messenger.disconnect();
      renderMessengerCard();
      renderInbox();
    });
  } else {
    wrap.innerHTML = `
      <form id="messengerConnectForm" class="channel-form">
        <div class="row">
          <label>Facebook Page name
            <input name="pageName" placeholder="West Coast FC" />
          </label>
          <label>Page ID
            <input name="pageId" placeholder="1029384756" required />
          </label>
        </div>
        <label>Page access token
          <input name="accessToken" type="password" placeholder="EAAB… (stored in this browser only)" required />
        </label>
        <div class="row">
          <label>Webhook verify token
            <input name="verifyToken" placeholder="optional — for your server webhook" />
          </label>
          <label class="check" style="align-self:end;">
            <input type="checkbox" name="live" /> Send live via Graph API
          </label>
        </div>
        <div class="channel-form-actions">
          <button type="button" class="btn" id="messengerDemo">Use demo connection</button>
          <div class="spacer"></div>
          <button type="submit" class="btn btn-primary">Connect Messenger</button>
        </div>
      </form>`;
    $('#messengerConnectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      Messenger.connect({
        pageName: f.pageName.value.trim(),
        pageId: f.pageId.value.trim(),
        accessToken: f.accessToken.value.trim(),
        verifyToken: f.verifyToken.value.trim(),
        live: f.live.checked,
      });
      renderMessengerCard();
      renderInbox();
    });
    $('#messengerDemo').addEventListener('click', () => {
      Messenger.connect({
        pageName: 'West Coast FC',
        pageId: '102938475610',
        accessToken: 'DEMO_TOKEN_local_only',
        verifyToken: 'wcs_verify',
        live: false,
      });
      renderMessengerCard();
      renderInbox();
    });
  }
}

/* ------------------------------- Modal ------------------------------- */

function openPostModal(id, seed = {}) {
  const modal = $('#postModal');
  const form = $('#postForm');
  form.reset();

  // Platform checkboxes
  const checks = $('#platformChecks');
  checks.innerHTML = PLATFORMS.map((p) => `
    <label class="check">
      <input type="checkbox" value="${p.id}" />
      ${p.label}
    </label>
  `).join('');

  // Game / asset selects
  const gameSel = form.elements.gameId;
  gameSel.innerHTML = `<option value="">— none —</option>` +
    state.games.map((g) => `<option value="${g.id}">vs ${escapeHtml(g.opponent)} · ${formatDate(g.date)}</option>`).join('');
  const assetSel = form.elements.assetId;
  assetSel.innerHTML = `<option value="">— none —</option>` +
    state.assets.map((a) => `<option value="${a.id}">${escapeHtml(a.title)}</option>`).join('');

  let post = id ? state.posts.find((p) => p.id === id) : null;

  if (post) {
    $('#postModalTitle').textContent = 'Edit post';
    form.elements.id.value = post.id;
    form.elements.caption.value = post.caption;
    form.elements.scheduledAt.value = toInputValue(post.scheduledAt);
    form.elements.status.value = post.status;
    form.elements.gameId.value = post.gameId || '';
    form.elements.assetId.value = post.assetId || '';
    checks.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = post.platforms.includes(cb.value);
    });
    $('#deletePostBtn').hidden = false;
  } else {
    $('#postModalTitle').textContent = 'Schedule post';
    form.elements.id.value = '';
    form.elements.caption.value = seed.caption || '';
    form.elements.scheduledAt.value = toInputValue(seed.scheduledAt || defaultSchedule());
    form.elements.status.value = 'scheduled';
    form.elements.gameId.value = seed.gameId || '';
    form.elements.assetId.value = seed.assetId || '';
    // Default to enabled accounts
    const enabled = new Set(state.accounts.filter((a) => a.enabled).map((a) => a.id));
    checks.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = enabled.has(cb.value); });
    $('#deletePostBtn').hidden = true;
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closePostModal() {
  const modal = $('#postModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function defaultSchedule() {
  const d = new Date();
  d.setHours(d.getHours() + 2, 0, 0, 0);
  return d.toISOString();
}

/* ------------------------------- Events ------------------------------ */

function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('[data-view-jump]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.viewJump)));

  $('#newPostBtn').addEventListener('click', () => openPostModal(null));
  $('#closeModal').addEventListener('click', closePostModal);
  $('#cancelPostBtn').addEventListener('click', closePostModal);
  $('#postModal').addEventListener('click', (e) => {
    if (e.target.id === 'postModal') closePostModal();
  });

  $('#postForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const platforms = $$('#platformChecks input:checked').map((cb) => cb.value);
    if (!platforms.length) { alert('Pick at least one platform.'); return; }
    const data = {
      caption: f.elements.caption.value.trim(),
      scheduledAt: new Date(f.elements.scheduledAt.value).toISOString(),
      status: f.elements.status.value,
      platforms,
      gameId: f.elements.gameId.value || null,
      assetId: f.elements.assetId.value || null,
    };
    const id = f.elements.id.value;
    if (id) {
      const p = state.posts.find((x) => x.id === id);
      Object.assign(p, data);
    } else {
      state.posts.push({ id: uid(), ...data });
    }
    save(); closePostModal(); renderAll();
  });

  $('#deletePostBtn').addEventListener('click', () => {
    const id = $('#postForm').elements.id.value;
    if (!id) return;
    if (!confirm('Delete this post?')) return;
    state.posts = state.posts.filter((p) => p.id !== id);
    save(); closePostModal(); renderAll();
  });

  ['filterStatus', 'filterPlatform', 'filterGame'].forEach((id) => {
    $('#' + id).addEventListener('change', renderPostsTable);
  });
  $('#globalSearch').addEventListener('input', () => {
    if (!$('.view[data-view="schedule"]').classList.contains('hidden')) renderPostsTable();
    if (!$('.view[data-view="inbox"]').classList.contains('hidden')) renderInbox();
  });

  $('#calPrev').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#calNext').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  $('#calToday').addEventListener('click', () => {
    calendarCursor = startOfMonth(new Date());
    renderCalendar();
  });

  $('#gameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const game = {
      id: uid(),
      opponent: f.elements.opponent.value.trim(),
      date: new Date(f.elements.date.value).toISOString(),
      homeAway: f.elements.homeAway.value,
      venue: f.elements.venue.value.trim(),
      sport: f.elements.sport.value.trim(),
    };
    state.games.push(game);
    save(); f.reset(); renderGames(); renderOverview();
  });

  $('#assetForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const asset = {
      id: uid(),
      title: f.elements.title.value.trim(),
      source: f.elements.source.value,
      url: f.elements.url.value.trim(),
      previewUrl: f.elements.previewUrl.value.trim(),
      tags: f.elements.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
    };
    state.assets.push(asset);
    save(); f.reset(); renderAssets();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePostModal();
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && document.activeElement.tagName !== 'INPUT'
        && document.activeElement.tagName !== 'TEXTAREA') {
      openPostModal(null);
    }
  });
}

/* ---------------------------- Safe helpers --------------------------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s).replaceAll('`', '&#96;'); }

/* --------------------------------- Go -------------------------------- */

function renderAll() {
  renderSidebarAccounts();
  renderOverview();
  renderInbox();
  renderPostsTable();
  renderCalendar();
  renderGames();
  renderAssets();
  renderAccounts();
  renderMessengerCard();
}

bindEvents();
renderAll();
setView('overview');
