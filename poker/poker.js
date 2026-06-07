/* West Coast Poker — play-money No-Limit Texas Hold'em vs. AI bots.
   Single-file engine + UI, persisted to localStorage. No dependencies. */

'use strict';

/* ------------------------------- Persistence ------------------------------- */

const STORAGE_KEY = 'wcp.state.v1';

const DEFAULT_SETTINGS = { bots: 3, startStack: 2000, bigBlind: 40 };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.settings) return { ...DEFAULT_SETTINGS, ...saved.settings };
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function loadBankroll(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Number.isFinite(saved.bankroll)) return saved.bankroll;
  } catch (_) { /* ignore */ }
  return fallback;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      settings: G.settings,
      bankroll: human() ? human().chips : G.settings.startStack,
    }));
  } catch (_) { /* storage full / disabled — ignore */ }
}

/* ------------------------------- Cards ------------------------------- */

const SUITS = ['s', 'h', 'd', 'c'];
const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_LABEL = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8',
  7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/* --------------------------- Hand evaluation ---------------------------
   Returns a comparable score array. Index 0 is category (8 = straight flush
   down to 0 = high card), followed by tie-breaker ranks (high to low). */

const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function rankFive(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);

  // Distinct ranks, descending, with wheel (A-5) handling for straights.
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
  }

  // Count duplicates: groups sorted by (count desc, rank desc).
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.keys(counts).map(r => ({ r: +r, c: counts[r] }))
    .sort((a, b) => (b.c - a.c) || (b.r - a.r));
  const shape = groups.map(g => g.c);
  const byCount = groups.map(g => g.r);

  if (straightHigh && isFlush) return [8, straightHigh];
  if (shape[0] === 4) return [7, byCount[0], byCount[1]];
  if (shape[0] === 3 && shape[1] === 2) return [6, byCount[0], byCount[1]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (shape[0] === 3) return [3, byCount[0], ...byCount.slice(1)];
  if (shape[0] === 2 && shape[1] === 2) return [2, byCount[0], byCount[1], byCount[2]];
  if (shape[0] === 2) return [1, byCount[0], ...byCount.slice(1)];
  return [0, ...ranks];
}

function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Best 5-card score from up to 7 cards.
function bestHand(cards) {
  if (cards.length < 5) return [-1];
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const score = rankFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScore(score, best) > 0) best = score;
          }
  return best;
}

/* ------------------------------- Game state ------------------------------- */

const BOT_NAMES = ['Maverick', 'Lola', 'Diesel', 'Sphinx', 'Roxy', 'Tank'];

const G = {
  settings: loadSettings(),
  players: [],
  deck: [],
  board: [],
  pots: [],          // resolved side pots at showdown
  pot: 0,            // chips committed this hand (display + total)
  currentBet: 0,     // highest bet to match this round
  minRaise: 0,       // minimum legal raise increment
  lastRaiser: -1,
  dealer: 0,
  toAct: -1,
  stage: 'idle',     // idle | preflop | flop | turn | river | showdown
  handActive: false,
};

function human() { return G.players.find(p => p.isHuman); }
function smallBlind() { return Math.floor(G.settings.bigBlind / 2); }

function buildPlayers() {
  const stack = G.settings.startStack;
  const players = [{ id: 0, name: 'You', isHuman: true, chips: loadBankroll(stack) }];
  for (let i = 0; i < G.settings.bots; i++) {
    players.push({ id: i + 1, name: BOT_NAMES[i % BOT_NAMES.length], isHuman: false, chips: stack });
  }
  for (const p of players) resetPlayerForHand(p);
  G.players = players;
  if (human().chips <= 0) human().chips = stack; // auto top-up the human's play money
}

function resetPlayerForHand(p) {
  p.hole = [];
  p.bet = 0;            // committed this betting round
  p.committed = 0;      // committed this whole hand (for side pots)
  p.folded = false;
  p.allIn = false;
  p.acted = false;      // has acted since last raise
  p.lastAction = '';
  p.winner = false;
}

/* ------------------------------- Logging ------------------------------- */

function log(msg, cls) {
  const ul = document.getElementById('log');
  const li = document.createElement('li');
  li.textContent = msg;
  if (cls) li.className = cls;
  ul.prepend(li);
  while (ul.children.length > 60) ul.removeChild(ul.lastChild);
}

/* ------------------------------- Hand flow ------------------------------- */

function activePlayers() { return G.players.filter(p => !p.folded); }
function contenders() { return G.players.filter(p => !p.folded && !p.allIn); }

function startHand() {
  // Drop anyone with no chips (bots bust out); refill human.
  G.players = G.players.filter(p => p.isHuman || p.chips > 0);
  if (human().chips <= 0) {
    human().chips = G.settings.startStack;
    log('You rebought for ' + fmt(G.settings.startStack) + ' (play money).');
  }
  if (G.players.length < 2) buildPlayers();

  for (const p of G.players) resetPlayerForHand(p);
  G.deck = shuffle(makeDeck());
  G.board = [];
  G.pots = [];
  G.pot = 0;
  G.currentBet = 0;
  G.minRaise = G.settings.bigBlind;
  G.handActive = true;
  G.stage = 'preflop';

  // Move the button to the next player still in the game.
  G.dealer = (G.dealer + 1) % G.players.length;

  document.getElementById('log').innerHTML = '';
  log('— New hand. Dealer: ' + G.players[G.dealer].name + ' —');

  // Blinds (heads-up: button posts small blind).
  const n = G.players.length;
  const sbIdx = n === 2 ? G.dealer : (G.dealer + 1) % n;
  const bbIdx = n === 2 ? (G.dealer + 1) % n : (G.dealer + 2) % n;
  postBlind(G.players[sbIdx], smallBlind(), 'small blind');
  postBlind(G.players[bbIdx], G.settings.bigBlind, 'big blind');
  G.currentBet = G.settings.bigBlind;
  G.lastRaiser = bbIdx;

  // Deal two hole cards to each player.
  for (let r = 0; r < 2; r++)
    for (const p of G.players) p.hole.push(G.deck.pop());

  // First to act preflop is left of big blind (or button heads-up).
  // Cursor sits on the BB; first actor is the next eligible seat (UTG, or the
  // button heads-up). The BB still has its option since acted is false.
  G.toAct = bbIdx;
  render();
  advance();
}

function postBlind(p, amount, label) {
  const pay = Math.min(amount, p.chips);
  p.chips -= pay;
  p.bet += pay;
  p.committed += pay;
  G.pot += pay;
  if (p.chips === 0) p.allIn = true;
  log(p.name + ' posts ' + label + ' ' + fmt(pay), p.isHuman ? 'you' : '');
}

// Find the next player who still needs to act this round, or -1 if betting closes.
function nextToAct(from) {
  const n = G.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    const p = G.players[idx];
    if (p.folded || p.allIn) continue;
    if (!p.acted || p.bet < G.currentBet) return idx;
  }
  return -1;
}

// Drive the game forward: resolve auto-wins, prompt human, or run a bot.
function advance() {
  persist();
  render();

  // Everyone but one folded → award immediately.
  if (activePlayers().length === 1) return endHand();

  // No one left to make a decision (all-in run-out).
  if (contenders().length === 0 && !roundUnsettled()) return runOutBoard();

  const idx = nextToAct(G.toAct);
  if (idx === -1) return advanceStreet();

  G.toAct = idx;
  const p = G.players[idx];
  render();

  if (p.isHuman) {
    showHumanControls();
  } else {
    hideHumanControls();
    setTimeout(() => botAct(p), 750 + Math.random() * 500);
  }
}

// True if a bet was made that not everyone has matched yet.
function roundUnsettled() {
  return G.players.some(p => !p.folded && !p.allIn && (p.bet < G.currentBet || !p.acted));
}

function advanceStreet() {
  // Collect this round's bets; reset per-round counters.
  for (const p of G.players) { p.bet = 0; p.acted = false; }
  G.currentBet = 0;
  G.minRaise = G.settings.bigBlind;

  if (G.stage === 'preflop') dealBoard('flop', 3);
  else if (G.stage === 'flop') dealBoard('turn', 1);
  else if (G.stage === 'turn') dealBoard('river', 1);
  else return endHand(); // after river

  // If no one can act anymore, just keep dealing to showdown.
  if (contenders().length < 2) return runOutBoard();

  // Action starts left of the button on every postflop street.
  G.toAct = G.dealer;
  advance();
}

function dealBoard(stage, count) {
  G.stage = stage;
  G.deck.pop(); // burn
  for (let i = 0; i < count; i++) G.board.push(G.deck.pop());
  log('— ' + stage.toUpperCase() + ': ' + G.board.map(cardText).join(' ') + ' —');
  render();
}

function runOutBoard() {
  // All remaining players are all-in (or only one can act): deal the rest.
  hideHumanControls();
  for (const p of G.players) { p.bet = 0; p.acted = true; }
  const step = () => {
    if (G.stage === 'preflop') dealBoard('flop', 3);
    else if (G.stage === 'flop') dealBoard('turn', 1);
    else if (G.stage === 'turn') dealBoard('river', 1);
    else return endHand();
    setTimeout(step, 800);
  };
  setTimeout(step, 700);
}

/* ------------------------------- Actions ------------------------------- */

function applyFold(p) {
  p.folded = true;
  p.acted = true;
  p.lastAction = 'Fold';
  log(p.name + ' folds', p.isHuman ? 'you' : '');
}

function applyCheckCall(p) {
  const owed = G.currentBet - p.bet;
  if (owed <= 0) {
    p.lastAction = 'Check';
    log(p.name + ' checks', p.isHuman ? 'you' : '');
  } else {
    const pay = Math.min(owed, p.chips);
    p.chips -= pay; p.bet += pay; p.committed += pay; G.pot += pay;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = p.allIn ? 'All-in ' + fmt(pay) : 'Call ' + fmt(pay);
    log(p.name + (p.allIn ? ' calls all-in ' : ' calls ') + fmt(pay), p.isHuman ? 'you' : '');
  }
  p.acted = true;
}

// `target` is the total this player's bet becomes (a raise-to amount).
function applyBet(p, target) {
  target = Math.min(target, p.bet + p.chips); // can't exceed stack
  const raiseSize = target - G.currentBet;
  const pay = target - p.bet;
  p.chips -= pay; p.bet += pay; p.committed += pay; G.pot += pay;
  if (p.chips === 0) p.allIn = true;

  const isRaise = G.currentBet > 0;
  if (raiseSize >= G.minRaise || !isRaise) G.minRaise = Math.max(G.minRaise, raiseSize);
  G.currentBet = Math.max(G.currentBet, p.bet);
  G.lastRaiser = p.id;

  // A genuine raise re-opens the action for everyone else.
  for (const o of G.players) if (o !== p && !o.folded && !o.allIn) o.acted = false;
  p.acted = true;

  const verb = isRaise ? 'raises to ' : 'bets ';
  p.lastAction = (p.allIn ? 'All-in ' : (isRaise ? 'Raise ' : 'Bet ')) + fmt(p.bet);
  log(p.name + (p.allIn ? ' is all-in ' : ' ' + verb) + fmt(p.bet), p.isHuman ? 'you' : '');
}

function humanAction(kind, amount) {
  const p = human();
  if (!p || G.toAct !== G.players.indexOf(p)) return;
  if (kind === 'fold') applyFold(p);
  else if (kind === 'check') applyCheckCall(p);
  else if (kind === 'call') applyCheckCall(p);
  else if (kind === 'bet') applyBet(p, amount);
  hideHumanControls();
  advance();
}

/* ------------------------------- Bot AI ------------------------------- */

// Cheap hand-strength estimate in [0,1] combining made-hand category and,
// preflop, a heuristic for the starting hand.
function botStrength(p) {
  if (G.board.length === 0) {
    const [a, b] = p.hole;
    const hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
    let s = (hi - 2) / 12 * 0.45 + (lo - 2) / 12 * 0.25;
    if (a.r === b.r) s += 0.32;                 // pocket pair
    if (a.s === b.s) s += 0.06;                 // suited
    const gap = hi - lo;
    if (gap === 1 && a.r !== b.r) s += 0.05;    // connected
    return Math.min(1, s);
  }
  const score = bestHand([...p.hole, ...G.board]);
  const cat = score[0]; // 0..8
  let s = cat / 8 * 0.85;
  if (cat <= 1) s += (score[1] || 0) / 14 * 0.15; // kicker/pair strength
  return Math.min(1, s);
}

function botAct(p) {
  if (!G.handActive || p.folded || p.allIn) return advance();
  const owed = G.currentBet - p.bet;
  const strength = botStrength(p);
  const potOdds = owed > 0 ? owed / (G.pot + owed) : 0;
  const bluff = Math.random() < 0.08;
  const r = Math.random();

  // Decide whether to raise, call/check, or fold.
  const wantRaise = (strength > 0.62 && r < 0.6) || (strength > 0.78) || bluff;
  const wantContinue = strength > potOdds + 0.05 || strength > 0.45;

  if (owed === 0) {
    // Option to check or bet.
    if (wantRaise && p.chips > 0) {
      const size = Math.max(G.settings.bigBlind, Math.round((G.pot * (0.5 + r * 0.5)) / 10) * 10);
      applyBet(p, Math.min(p.bet + p.chips, Math.max(G.currentBet, p.bet) + size));
    } else {
      applyCheckCall(p);
    }
  } else if (wantRaise && p.chips > owed) {
    const size = Math.max(G.minRaise, Math.round((G.pot * (0.5 + r * 0.4)) / 10) * 10);
    applyBet(p, G.currentBet + size);
  } else if (wantContinue || owed <= G.settings.bigBlind) {
    applyCheckCall(p);
  } else {
    applyFold(p);
  }
  advance();
}

/* ------------------------------- Showdown ------------------------------- */

function endHand() {
  G.handActive = false;
  G.stage = 'showdown';
  hideHumanControls();

  const alive = activePlayers();
  if (alive.length === 1) {
    const w = alive[0];
    w.chips += G.pot;
    w.winner = true;
    log(w.name + ' wins ' + fmt(G.pot) + ' (everyone folded)', 'win');
  } else {
    // Build side pots from per-hand contributions, then award each.
    awardSidePots(alive);
  }

  G.pot = 0;
  persist();
  render(true);
  showDealButton();
}

function awardSidePots(showdownPlayers) {
  // Every player who put chips in (even folded) contributes to pots.
  const all = G.players.filter(p => p.committed > 0);
  const levels = [...new Set(all.map(p => p.committed))].sort((a, b) => a - b);

  let prev = 0;
  const pots = [];
  for (const lvl of levels) {
    let amount = 0;
    for (const p of all) amount += Math.max(0, Math.min(p.committed, lvl) - prev);
    const eligible = showdownPlayers.filter(p => p.committed >= lvl);
    if (amount > 0) pots.push({ amount, eligible });
    prev = lvl;
  }

  // Reveal contenders.
  for (const p of showdownPlayers) {
    p.score = bestHand([...p.hole, ...G.board]);
    log(p.name + ' shows ' + p.hole.map(cardText).join(' ') + ' — ' + CATEGORY[p.score[0]],
      p.isHuman ? 'you' : '');
  }

  for (const pot of pots) {
    if (pot.eligible.length === 0) continue;
    let best = null;
    for (const p of pot.eligible) if (!best || compareScore(p.score, best.score) > 0) best = p;
    const winners = pot.eligible.filter(p => compareScore(p.score, best.score) === 0);
    const share = Math.floor(pot.amount / winners.length);
    let rem = pot.amount - share * winners.length;
    for (const w of winners) {
      let take = share;
      if (rem > 0) { take += 1; rem -= 1; } // odd chip to first winner(s)
      w.chips += take;
      w.winner = true;
    }
    const names = winners.map(w => w.name).join(', ');
    log(names + ' win ' + fmt(pot.amount) + ' with ' + CATEGORY[best.score[0]], 'win');
  }
}

/* ------------------------------- Formatting ------------------------------- */

function fmt(n) { return Number(n).toLocaleString('en-US'); }
function cardText(c) { return RANK_LABEL[c.r] + SUIT_SYM[c.s]; }

/* ------------------------------- Rendering ------------------------------- */

// Seat coordinates as % of the felt, with the human anchored bottom-center.
function seatPositions(n) {
  const layouts = {
    2: [[50, 90], [50, 12]],
    3: [[50, 90], [12, 30], [88, 30]],
    4: [[50, 90], [10, 45], [50, 10], [90, 45]],
    5: [[50, 90], [10, 55], [25, 16], [75, 16], [90, 55]],
    6: [[50, 90], [10, 60], [18, 20], [82, 20], [90, 60], [50, 10]],
  };
  return layouts[n] || layouts[6];
}

function cardEl(c, faceDown, big) {
  const el = document.createElement('div');
  el.className = 'card' + (big ? ' big' : '');
  if (faceDown) { el.classList.add('back'); return el; }
  if (c.s === 'h' || c.s === 'd') el.classList.add('red');
  const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = RANK_LABEL[c.r];
  const suit = document.createElement('span'); suit.className = 'suit'; suit.textContent = SUIT_SYM[c.s];
  el.appendChild(rank); el.appendChild(suit);
  return el;
}

function render(reveal = false) {
  // Bankroll
  document.getElementById('bankroll').textContent = human() ? fmt(human().chips) : '—';
  document.getElementById('pot').textContent = fmt(G.pot);
  document.getElementById('stageLabel').textContent =
    G.stage === 'idle' ? 'Press “Deal” to start'
    : G.stage === 'showdown' ? 'Showdown' : G.stage[0].toUpperCase() + G.stage.slice(1);

  // Board
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (const c of G.board) board.appendChild(cardEl(c, false, true));

  // Seats
  const seats = document.getElementById('seats');
  seats.innerHTML = '';
  const pos = seatPositions(G.players.length);
  G.players.forEach((p, i) => {
    const [x, y] = pos[i] || [50, 50];
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.style.left = x + '%';
    seat.style.top = y + '%';
    if (p.folded) seat.classList.add('folded');
    if (G.toAct === i && G.handActive && !p.folded) seat.classList.add('active');
    if (p.winner) seat.classList.add('winner');

    const name = document.createElement('div');
    name.className = 'seat-name';
    name.textContent = p.name;
    if (i === G.dealer) {
      const d = document.createElement('span'); d.className = 'dealer-btn'; d.textContent = 'D';
      name.appendChild(d);
    }
    seat.appendChild(name);

    const chips = document.createElement('div');
    chips.className = 'seat-chips';
    chips.textContent = fmt(p.chips);
    seat.appendChild(chips);

    const meta = document.createElement('div');
    meta.className = 'seat-meta';
    meta.textContent = p.allIn ? 'ALL-IN' : (p.lastAction || (p.folded ? 'Folded' : ''));
    seat.appendChild(meta);

    const hand = document.createElement('div');
    hand.className = 'hand';
    const showCards = p.isHuman || (reveal && !p.folded);
    if (p.hole.length) {
      for (const c of p.hole) hand.appendChild(cardEl(c, !showCards, false));
    }
    seat.appendChild(hand);

    if (p.bet > 0) {
      const chip = document.createElement('div');
      chip.className = 'bet-chip';
      chip.textContent = fmt(p.bet);
      seat.appendChild(chip);
    }
    seats.appendChild(seat);
  });
}

/* ------------------------------- Controls ------------------------------- */

const actionButtons = document.getElementById('actionButtons');
const betControls = document.getElementById('betControls');
const betSlider = document.getElementById('betSlider');
const betAmount = document.getElementById('betAmount');
const betQuick = document.getElementById('betQuick');

function showDealButton() {
  actionButtons.innerHTML = '';
  betControls.classList.add('hidden');
  const b = document.createElement('button');
  b.className = 'btn btn-primary btn-lg';
  b.textContent = 'Deal next hand';
  b.onclick = () => startHand();
  actionButtons.appendChild(b);
}

function hideHumanControls() {
  actionButtons.innerHTML = '';
  betControls.classList.add('hidden');
}

function showHumanControls() {
  const p = human();
  const owed = G.currentBet - p.bet;
  actionButtons.innerHTML = '';

  const mkBtn = (label, cls, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.disabled = !!disabled;
    b.onclick = fn;
    actionButtons.appendChild(b);
    return b;
  };

  mkBtn('Fold', 'btn-danger', () => humanAction('fold'));

  if (owed <= 0) {
    mkBtn('Check', '', () => humanAction('check'));
  } else {
    const callAmt = Math.min(owed, p.chips);
    mkBtn('Call ' + fmt(callAmt), '', () => humanAction('call'));
  }

  // Bet / raise controls — only if the player has chips beyond the call.
  const maxTotal = p.bet + p.chips;            // raise-to ceiling (all-in)
  const minTotal = G.currentBet > 0
    ? Math.min(maxTotal, G.currentBet + G.minRaise)
    : Math.min(maxTotal, G.settings.bigBlind);
  const canRaise = maxTotal > G.currentBet && p.chips > owed;

  if (canRaise) {
    const label = G.currentBet > 0 ? 'Raise' : 'Bet';
    mkBtn(label + '…', 'btn-primary', () => openBetControls(minTotal, maxTotal, label));
  } else if (p.chips > 0 && owed > 0 && p.chips <= owed) {
    // Can only call all-in; already offered via Call button above.
  }
}

function openBetControls(min, max, label) {
  betControls.classList.remove('hidden');
  betSlider.min = String(min);
  betSlider.max = String(max);
  betSlider.step = String(Math.max(G.settings.bigBlind / 2, 1));
  betSlider.value = String(min);
  betAmount.textContent = fmt(min);
  betSlider.oninput = () => { betAmount.textContent = fmt(+betSlider.value); };

  // Quick-size buttons (pot fractions + all-in), clamped to legal range.
  betQuick.innerHTML = '';
  const quick = [
    ['½ Pot', G.pot * 0.5],
    ['¾ Pot', G.pot * 0.75],
    ['Pot', G.pot],
    ['All-in', max],
  ];
  for (const [name, raw] of quick) {
    const target = name === 'All-in' ? max
      : Math.min(max, Math.max(min, G.currentBet + Math.round(raw / 10) * 10));
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = name;
    b.onclick = () => { betSlider.value = String(target); betAmount.textContent = fmt(target); };
    betQuick.appendChild(b);
  }

  // Replace the bet button with a Confirm.
  const confirm = document.createElement('button');
  confirm.className = 'btn btn-primary';
  confirm.textContent = 'Confirm ' + label;
  confirm.onclick = () => humanAction('bet', +betSlider.value);
  actionButtons.appendChild(confirm);
}

/* ------------------------------- Settings ------------------------------- */

const dialog = document.getElementById('settingsDialog');
document.getElementById('settingsBtn').onclick = () => {
  document.getElementById('setBots').value = String(G.settings.bots);
  document.getElementById('setStack').value = String(G.settings.startStack);
  document.getElementById('setBlind').value = String(G.settings.bigBlind);
  dialog.showModal();
};

dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'save') {
    G.settings = {
      bots: +document.getElementById('setBots').value,
      startStack: +document.getElementById('setStack').value,
      bigBlind: +document.getElementById('setBlind').value,
    };
    buildPlayers();
    persist();
    G.stage = 'idle';
    G.handActive = false;
    document.getElementById('log').innerHTML = '';
    log('Table reset with new settings.');
    render();
    showDealButton();
  }
});

document.getElementById('resetBankroll').onclick = () => {
  if (human()) human().chips = G.settings.startStack;
  persist();
  render();
  log('Bankroll reset to ' + fmt(G.settings.startStack) + '.');
};

/* ------------------------------- Boot ------------------------------- */

buildPlayers();
render();
showDealButton();
log('Welcome to West Coast Poker. Press “Deal next hand” to play.');
