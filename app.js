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
  { id: 'letspoker', label: 'LetsPoker', handle: '/clubwestcoast' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  return { posts, games, assets, accounts };
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

function endOfMonthInput(d) {
  const x = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

// All dates between start and until (inclusive) falling on the given weekdays,
// at the start's time of day. Hard-capped so a far-future "until" can't
// generate an unbounded series.
function computeOccurrences(startValue, weekdays, untilValue) {
  const start = new Date(startValue);
  if (isNaN(start) || !untilValue) return [];
  const until = new Date(untilValue + 'T23:59:59');
  const wanted = new Set(weekdays);
  const out = [];
  const cursor = new Date(start);
  for (let i = 0; i < 366 && cursor <= until && out.length < 60; i++) {
    if (wanted.has(cursor.getDay())) out.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function platformBadge(id) {
  const p = platformById(id);
  if (!p) return '';
  return `<span class="p-badge p-${id}">${p.label}</span>`;
}

function statusChip(status) {
  return `<span class="status-chip status-${status}">${status}</span>`;
}

function seriesFlag(post) {
  return post.seriesId ? `<span class="repeat-flag" title="Part of a weekly series">↻</span>` : '';
}

/* ------------------------------ Routing ------------------------------ */

function setView(view) {
  $$('.view').forEach((el) => el.classList.toggle('hidden', el.dataset.view !== view));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const titles = {
    overview: ['Overview', 'Everything scheduled across your pages, in one place.'],
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
  if (view === 'schedule') renderPostsTable();
  if (view === 'games') renderGames();
  if (view === 'assets') renderAssets();
  if (view === 'accounts') renderAccounts();
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
                ${game ? 'vs ' + escapeHtml(game.opponent) + ' · ' : ''}${statusChip(p.status)}${seriesFlag(p)}
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
        <div>${statusChip(p.status)}${seriesFlag(p)}</div>
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

/* ------------------------------- Modal ------------------------------- */

// Tracks whether the user has manually picked repeat days; until then the
// selection follows the "Schedule for" date's weekday.
let repeatDaysTouched = false;

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

  form.elements.repeat.value = 'none';
  const seriesNote = $('#seriesNote');

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
    $('#repeatRow').classList.add('hidden');
    if (post.seriesId) {
      const count = state.posts.filter((p) => p.seriesId === post.seriesId).length;
      seriesNote.textContent = `↻ Part of a weekly series — ${count} post${count === 1 ? '' : 's'} total. Changes here only affect this post.`;
      seriesNote.classList.remove('hidden');
    } else {
      seriesNote.classList.add('hidden');
    }
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
    $('#repeatRow').classList.remove('hidden');
    seriesNote.classList.add('hidden');

    repeatDaysTouched = false;
    const start = new Date(form.elements.scheduledAt.value);
    $('#repeatDays').innerHTML = DAY_NAMES.map((name, i) => `
      <label class="check">
        <input type="checkbox" value="${i}" ${i === start.getDay() ? 'checked' : ''} />
        ${name}
      </label>
    `).join('');
    form.elements.repeatUntil.value = endOfMonthInput(start);
  }

  updateRepeatUI();
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function selectedRepeatDays() {
  return $$('#repeatDays input:checked').map((cb) => Number(cb.value));
}

function updateRepeatUI() {
  const form = $('#postForm');
  const weekly = !form.elements.id.value && form.elements.repeat.value === 'weekly';
  $$('.repeat-only').forEach((el) => el.classList.toggle('hidden', !weekly));
  if (!weekly) return;

  const start = new Date(form.elements.scheduledAt.value);
  if (!isNaN(start) &&
      (!form.elements.repeatUntil.value || new Date(form.elements.repeatUntil.value + 'T23:59:59') < start)) {
    form.elements.repeatUntil.value = endOfMonthInput(start);
  }

  const preview = $('#repeatPreview');
  const days = selectedRepeatDays();
  if (!days.length) {
    preview.textContent = 'Pick at least one day of the week.';
    return;
  }
  const occurrences = computeOccurrences(form.elements.scheduledAt.value, days, form.elements.repeatUntil.value);
  if (!occurrences.length) {
    preview.textContent = 'No matching dates before the end date.';
    return;
  }
  const fmt = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const shown = occurrences.slice(0, 5).map(fmt).join(' · ');
  const extra = occurrences.length > 5 ? ` +${occurrences.length - 5} more` : '';
  preview.textContent = `Creates ${occurrences.length} post${occurrences.length === 1 ? '' : 's'}: ${shown}${extra}`;
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
    } else if (f.elements.repeat.value === 'weekly') {
      const days = selectedRepeatDays();
      if (!days.length) { alert('Pick at least one day of the week to repeat on.'); return; }
      const occurrences = computeOccurrences(f.elements.scheduledAt.value, days, f.elements.repeatUntil.value);
      if (!occurrences.length) { alert('No matching dates before the end date — check the repeat days and "until" date.'); return; }
      const seriesId = uid();
      for (const d of occurrences) {
        state.posts.push({ id: uid(), ...data, scheduledAt: d.toISOString(), seriesId });
      }
    } else {
      state.posts.push({ id: uid(), ...data });
    }
    save(); closePostModal(); renderAll();
  });

  $('#deletePostBtn').addEventListener('click', () => {
    const id = $('#postForm').elements.id.value;
    if (!id) return;
    const post = state.posts.find((p) => p.id === id);
    if (!post) return;
    if (!confirm('Delete this post?')) return;
    const siblings = post.seriesId
      ? state.posts.filter((p) => p.seriesId === post.seriesId && p.id !== id)
      : [];
    if (siblings.length &&
        confirm(`This post repeats weekly. Also delete the other ${siblings.length} post${siblings.length === 1 ? '' : 's'} in the series?`)) {
      state.posts = state.posts.filter((p) => p.seriesId !== post.seriesId);
    } else {
      state.posts = state.posts.filter((p) => p.id !== id);
    }
    save(); closePostModal(); renderAll();
  });

  $('#postForm').elements.repeat.addEventListener('change', updateRepeatUI);
  $('#postForm').elements.repeatUntil.addEventListener('change', updateRepeatUI);
  $('#postForm').elements.scheduledAt.addEventListener('change', () => {
    const form = $('#postForm');
    if (!form.elements.id.value && !repeatDaysTouched) {
      const start = new Date(form.elements.scheduledAt.value);
      if (!isNaN(start)) {
        $$('#repeatDays input').forEach((cb) => { cb.checked = Number(cb.value) === start.getDay(); });
      }
    }
    updateRepeatUI();
  });
  $('#repeatDays').addEventListener('change', () => { repeatDaysTouched = true; updateRepeatUI(); });

  ['filterStatus', 'filterPlatform', 'filterGame'].forEach((id) => {
    $('#' + id).addEventListener('change', renderPostsTable);
  });
  $('#globalSearch').addEventListener('input', () => {
    if (!$('.view[data-view="schedule"]').classList.contains('hidden')) renderPostsTable();
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
  renderPostsTable();
  renderCalendar();
  renderGames();
  renderAssets();
  renderAccounts();
}

bindEvents();
renderAll();
setView('overview');
