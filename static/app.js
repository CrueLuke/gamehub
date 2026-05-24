// === Globální stav ===

let currentUser = null;           // { username, stats }
let socket = null;                // Socket.IO spojení
let pendingRoomId = null;         // místnost z URL k auto-připojení po loginu
let gameKind = 'ai';              // 'ai' | 'pvp'
let pvpRoom = null;               // aktuální stav PvP místnosti ze serveru

// === API helper ===

async function api(path, method = 'GET', body = null) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.error || 'Chyba serveru.');
  return data;
}

// === Statistiky ===

function renderStats() {
  if (!currentUser) return;
  const s = currentUser.stats || {};
  document.getElementById('stat-ai-wins').textContent   = s.ai_wins  ?? 0;
  document.getElementById('stat-ai-losses').textContent = s.ai_losses ?? 0;
  document.getElementById('stat-ai-draws').textContent  = s.ai_draws ?? 0;
  document.getElementById('stat-pvp-wins').textContent   = s.pvp_wins  ?? 0;
  document.getElementById('stat-pvp-losses').textContent = s.pvp_losses ?? 0;
  document.getElementById('stat-pvp-draws').textContent  = s.pvp_draws ?? 0;
}

async function refreshStats() {
  try {
    const data = await api('/api/me');
    currentUser = data;
    renderStats();
  } catch (_) { /* nepřihlášený, ignoruj */ }
}

// === Přepínání obrazovek ===

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById(screenId);
  target.classList.remove('hidden');
  // Drawing Competition obrazovky mají červené pozadí celé stránky
  document.body.classList.toggle('dc-active', target.classList.contains('dc-theme'));
}

function showMenu() {
  if (!currentUser) { show('auth-screen'); return; }
  document.getElementById('welcome-name').textContent = currentUser.username;
  renderStats();
  document.getElementById('pvp-scores').classList.add('hidden');
  cancelTurnTimer();
  show('menu-screen');
}

// === Přihlášení / Registrace ===

let authMode = 'login';
const tabLogin = document.getElementById('tab-login');
const tabReg = document.getElementById('tab-register');
const authSubmit = document.getElementById('auth-submit');
const authError = document.getElementById('auth-error');

function setAuthMode(m) {
  authMode = m;
  tabLogin.classList.toggle('active', m === 'login');
  tabReg.classList.toggle('active', m === 'register');
  authSubmit.textContent = m === 'login' ? 'Přihlásit' : 'Zaregistrovat';
  authError.textContent = '';
}

tabLogin.addEventListener('click', () => setAuthMode('login'));
tabReg.addEventListener('click', () => setAuthMode('register'));

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.textContent = '';
  const name = document.getElementById('username').value.trim();
  const pw = document.getElementById('password').value;
  if (!name || !pw) { authError.textContent = 'Vyplň jméno i heslo.'; return; }
  try {
    const path = authMode === 'register' ? '/api/register' : '/api/login';
    const data = await api(path, 'POST', { username: name, password: pw });
    currentUser = data;
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    onLoginSuccess();
  } catch (err) {
    authError.textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST'); } catch (_) {}
  currentUser = null;
  if (socket) { socket.disconnect(); socket = null; }
  cancelTurnTimer();
  setAuthMode('login');
  show('auth-screen');
});

function onLoginSuccess() {
  connectSocket();
  if (pendingRoomId) {
    const rid = pendingRoomId;
    pendingRoomId = null;
    history.replaceState({}, '', location.pathname);
    if (socket.connected) socket.emit('join_room', { room_id: rid });
    else socket.once('connect', () => socket.emit('join_room', { room_id: rid }));
    return;
  }
  if (pendingDcRoomId) {
    const rid = pendingDcRoomId;
    pendingDcRoomId = null;
    history.replaceState({}, '', location.pathname);
    if (socket.connected) socket.emit('dc_join_room', { room_id: rid });
    else socket.once('connect', () => socket.emit('dc_join_room', { room_id: rid }));
    return;
  }
  showMenu();
}

// === Socket.IO ===

function connectSocket() {
  if (socket) return;
  socket = io({ autoConnect: true });

  socket.on('room_state', state => {
    pvpRoom = state;
    if (state.status === 'waiting') {
      showPvpWaiting(state);
    } else {
      enterPvpGame(state);
    }
  });

  socket.on('error', err => {
    alert(err.message || 'Chyba spojení.');
    showMenu();
  });

  socket.on('opponent_left', () => {
    if (gameKind !== 'pvp') return;
    gameOver = true;
    cancelTurnTimer();
    statusEl.textContent = '';
    if (pvpRoom) {
      const line = pvpRoom.status === 'over' ? pvpRoom.winning_line : null;
      renderBoardPvp(pvpRoom, line);
    }
    gameOverText.textContent = '😶 Soupeř opustil hru.';
    gameOverEl.classList.remove('hidden');
    playAgainBtn.classList.remove('hidden');
    playAgainBtn.textContent = 'Zpět do menu';
    playAgainBtn.disabled = false;
    document.getElementById('rematch-hint').classList.add('hidden');
    pvpRoom = null; // místnost už není
  });
}

// === PvP UI handlery ===

document.getElementById('play-pvp-btn').addEventListener('click', () => show('pvp-mode-screen'));
document.getElementById('pvp-mode-back-btn').addEventListener('click', showMenu);

document.querySelectorAll('[data-pvp-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!socket) connectSocket();
    const sendCreate = () => socket.emit('create_room', { mode: btn.dataset.pvpMode });
    if (socket.connected) sendCreate();
    else socket.once('connect', sendCreate);
  });
});

document.getElementById('pvp-waiting-cancel-btn').addEventListener('click', () => {
  if (socket) socket.emit('leave_room');
  pvpRoom = null;
  showMenu();
});

document.getElementById('pvp-copy-btn').addEventListener('click', async () => {
  const input = document.getElementById('pvp-invite-url');
  const url = input.value;
  const fb = document.getElementById('pvp-copy-feedback');
  try {
    await navigator.clipboard.writeText(url);
    fb.textContent = '✓ Zkopírováno!';
  } catch {
    input.select();
    try { document.execCommand('copy'); fb.textContent = '✓ Zkopírováno!'; }
    catch { fb.textContent = 'Zkopíruj ručně: ' + url; }
  }
});

function showPvpWaiting(state) {
  const url = `${location.origin}${location.pathname}?room=${state.room_id}`;
  document.getElementById('pvp-invite-url').value = url;
  document.getElementById('pvp-copy-feedback').textContent = '';
  show('pvp-waiting-screen');
}

// === Společná logika hrací plochy ===

const MODES = {
  classic: { size: 3, winLen: 3, label: 'Klasické 3×3' },
  open:    { size: 15, winLen: 5, label: 'Velká plocha (5 v řadě)' }
};

let currentModeName = 'classic';
let mode = MODES.classic;
let board = [];
let gameOver = false;
let humanTurn = true;
let lastMoveIndex = null;     // poslední tah v AI módu (pro animaci)
let turnReminderTimer = null; // 20s timer připomínky

// === Připomínka „jsi na tahu" ===

function startTurnTimer() {
  cancelTurnTimer();
  turnReminderTimer = setTimeout(() => {
    document.getElementById('turn-reminder').classList.remove('hidden');
  }, 20000);
}

function cancelTurnTimer() {
  if (turnReminderTimer) {
    clearTimeout(turnReminderTimer);
    turnReminderTimer = null;
  }
  document.getElementById('turn-reminder').classList.add('hidden');
}

// === Konfety při výhře (jen v PvP) ===

function celebrateWin(winnerSymbol) {
  if (typeof confetti !== 'function') return;
  // X vítězí → konfety zprava, O → zleva
  const fromRight = winnerSymbol === 'X';
  const origin = fromRight ? { x: 1, y: 0.55 } : { x: 0, y: 0.55 };
  const angle  = fromRight ? 135 : 45;
  const colors = ['#667eea', '#764ba2', '#10b981', '#f59e0b', '#ef4444', '#ffffff'];
  const burst = (delay, count, spread) => setTimeout(() => {
    confetti({ particleCount: count, spread, angle, origin, colors, startVelocity: 55, scalar: 1.05 });
  }, delay);
  burst(0,   90,  75);
  burst(180, 70,  100);
  burst(360, 60,  110);
}

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('game-status');
const gameOverEl = document.getElementById('game-over');
const gameOverText = document.getElementById('game-over-text');
const playAgainBtn = document.getElementById('play-again-btn');

function applyBoardStyle(modeName, size) {
  boardEl.className = modeName === 'classic' ? 'board-classic' : 'board-open';
  boardEl.style.setProperty('--size', size);
  // V open módu rozšířit herní obrazovku, aby byly kameny větší
  document.getElementById('game-screen').classList.toggle('wide', modeName === 'open');
  if (modeName === 'classic') {
    boardEl.style.setProperty('--cell-font', '3.5rem');
    boardEl.style.setProperty('--cell-radius', '8px');
    boardEl.style.setProperty('--gap', '8px');
  } else {
    boardEl.style.setProperty('--cell-font', '1.6rem');
    boardEl.style.setProperty('--cell-radius', '4px');
    boardEl.style.setProperty('--gap', '2px');
  }
}

function checkWinAt(b, idx, player, size, winLen) {
  const r0 = Math.floor(idx / size), c0 = idx % size;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    const line = [idx];
    for (let s = 1; ; s++) {
      const r = r0 + s*dr, c = c0 + s*dc;
      if (r < 0 || r >= size || c < 0 || c >= size) break;
      if (b[r*size + c] !== player) break;
      line.push(r*size + c);
    }
    for (let s = 1; ; s++) {
      const r = r0 - s*dr, c = c0 - s*dc;
      if (r < 0 || r >= size || c < 0 || c >= size) break;
      if (b[r*size + c] !== player) break;
      line.push(r*size + c);
    }
    if (line.length >= winLen) return line;
  }
  return null;
}

// === AI mód ===

let pendingModeName = 'classic';
let currentDifficulty = 'hard';

document.getElementById('play-classic-btn').addEventListener('click', () => showDifficulty('classic'));
document.getElementById('play-open-btn').addEventListener('click', () => showDifficulty('open'));
document.getElementById('diff-back-btn').addEventListener('click', showMenu);

document.querySelectorAll('[data-difficulty]').forEach(btn => {
  btn.addEventListener('click', () => {
    currentDifficulty = btn.dataset.difficulty;
    startAiGame(pendingModeName);
  });
});

function showDifficulty(modeName) {
  pendingModeName = modeName;
  document.getElementById('difficulty-mode-label').textContent = MODES[modeName].label;
  show('difficulty-screen');
}

function difficultyLabel(d) {
  return { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[d] || d;
}

document.getElementById('back-btn').addEventListener('click', () => {
  if (gameKind === 'pvp') {
    if (socket) socket.emit('leave_room');
    pvpRoom = null;
  }
  showMenu();
});

playAgainBtn.addEventListener('click', () => {
  if (gameKind === 'ai') {
    startAiGame(currentModeName);
  } else if (!pvpRoom) {
    // Soupeř odešel — místnost je zrušená, jen zpět do menu
    showMenu();
  } else {
    // PvP: požádat o rematch (server čeká, až obě strany kliknou)
    socket.emit('rematch');
  }
});

function startAiGame(modeName) {
  gameKind = 'ai';
  currentModeName = modeName;
  mode = MODES[modeName];
  board = Array(mode.size * mode.size).fill(null);
  gameOver = false;
  humanTurn = true;
  lastMoveIndex = null;
  gameOverEl.classList.add('hidden');
  playAgainBtn.classList.remove('hidden');
  playAgainBtn.textContent = 'Hrát znovu';
  playAgainBtn.disabled = false;
  document.getElementById('rematch-hint').classList.add('hidden');
  document.getElementById('pvp-scores').classList.add('hidden');
  statusEl.textContent = `Tvůj tah (X) — ${mode.label} · ${difficultyLabel(currentDifficulty)}`;
  applyBoardStyle(modeName, mode.size);
  renderBoardAi();
  startTurnTimer();  // hráč je na tahu, spustit timer
  show('game-screen');
}

function renderBoardAi(winningLine) {
  boardEl.innerHTML = '';
  for (let i = 0; i < board.length; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell';
    if (board[i]) {
      btn.textContent = board[i];
      btn.classList.add(board[i].toLowerCase());
      btn.disabled = true;
      if (i === lastMoveIndex) btn.classList.add('cell-just-placed');
    } else if (gameOver || !humanTurn) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => humanMove(i));
    }
    if (winningLine && winningLine.includes(i)) btn.classList.add('winning');
    boardEl.appendChild(btn);
  }
}

const HUMAN = 'X';
const AI = 'O';

function aiMoveResult(idx, player) {
  const line = checkWinAt(board, idx, player, mode.size, mode.winLen);
  if (line) return { winner: player, line };
  if (board.every(Boolean)) return { winner: 'draw', line: null };
  return null;
}

function humanMove(i) {
  if (gameOver || board[i] || !humanTurn) return;
  board[i] = HUMAN;
  humanTurn = false;
  lastMoveIndex = i;
  cancelTurnTimer();  // tah proveden, zruš připomínku
  const info = aiMoveResult(i, HUMAN);
  if (info) { finishAiGame(info); return; }
  renderBoardAi();
  statusEl.textContent = 'Tah AI…';
  setTimeout(aiMove, 400);  // chvíli, aby byla vidět animace umístění
}

function aiMove() {
  if (gameOver) return;
  const moveIdx = (currentModeName === 'classic')
    ? pickAiClassic(currentDifficulty)
    : pickAiOpen(currentDifficulty);
  board[moveIdx] = AI;
  lastMoveIndex = moveIdx;
  humanTurn = true;
  const info = aiMoveResult(moveIdx, AI);
  if (info) { finishAiGame(info); return; }
  renderBoardAi();
  statusEl.textContent = `Tvůj tah (X) — ${mode.label} · ${difficultyLabel(currentDifficulty)}`;
  startTurnTimer();  // hráč je zase na tahu
}

async function finishAiGame(info) {
  gameOver = true;
  cancelTurnTimer();
  let msg, result;
  if (info.winner === HUMAN) { msg = '🎉 Vyhrál jsi!'; result = 'win'; }
  else if (info.winner === AI) { msg = '😞 AI vyhrála.'; result = 'loss'; }
  else { msg = '🤝 Remíza.'; result = 'draw'; }
  renderBoardAi(info.line);
  statusEl.textContent = '';
  gameOverText.textContent = msg;
  gameOverEl.classList.remove('hidden');
  try {
    const data = await api('/api/record-ai-result', 'POST', { result });
    currentUser.stats = data.stats;
    renderStats();
  } catch (_) {}
}

// === AI: Klasické 3×3 ===

const CLASSIC_RANDOM = { easy: 0.8, medium: 0.55, hard: 0.3 };

function pickAiClassic(difficulty) {
  const empty = board.map((v, i) => v ? -1 : i).filter(i => i >= 0);
  if (Math.random() < CLASSIC_RANDOM[difficulty]) {
    return empty[Math.floor(Math.random() * empty.length)];
  }
  return minimax(board, AI).index;
}

function minimax(b, player) {
  for (let i = 0; i < b.length; i++) {
    if (!b[i]) continue;
    const line = checkWinAt(b, i, b[i], 3, 3);
    if (line) return { score: b[i] === AI ? 10 : -10 };
  }
  if (b.every(Boolean)) return { score: 0 };
  const moves = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i]) continue;
    b[i] = player;
    const result = minimax(b, player === AI ? HUMAN : AI);
    moves.push({ index: i, score: result.score });
    b[i] = null;
  }
  if (player === AI) {
    return moves.reduce((best, m) => m.score > best.score ? m : best, { score: -Infinity });
  } else {
    return moves.reduce((best, m) => m.score < best.score ? m : best, { score: Infinity });
  }
}

// === AI: Velká plocha (15×15) ===

const PATTERN_SCORES = [0, 1, 10, 100, 1000, 100000];

function getCandidates(b, size) {
  const set = new Set();
  let hasStone = false;
  for (let i = 0; i < b.length; i++) {
    if (!b[i]) continue;
    hasStone = true;
    const r = Math.floor(i / size), c = i % size;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const ni = nr*size + nc;
        if (!b[ni]) set.add(ni);
      }
    }
  }
  if (!hasStone) return [Math.floor(size*size/2)];
  return [...set];
}

function evaluateBoard(b, size, winLen, defenseBias) {
  let score = 0;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      for (const [dr, dc] of dirs) {
        const endR = r + (winLen-1)*dr, endC = c + (winLen-1)*dc;
        if (endR < 0 || endR >= size || endC < 0 || endC >= size) continue;
        let ai = 0, hu = 0;
        for (let k = 0; k < winLen; k++) {
          const cell = b[(r+k*dr)*size + (c+k*dc)];
          if (cell === AI) ai++;
          else if (cell === HUMAN) hu++;
        }
        if (ai && hu) continue;
        if (ai) score += PATTERN_SCORES[ai];
        else if (hu) score -= PATTERN_SCORES[hu] * defenseBias;
      }
    }
  }
  return score;
}

function scoreCandidates(candidates, size, winLen, defenseBias) {
  const scored = [];
  for (const i of candidates) {
    board[i] = AI;
    const aiScore = evaluateBoard(board, size, winLen, defenseBias);
    board[i] = HUMAN;
    const huScore = evaluateBoard(board, size, winLen, defenseBias);
    board[i] = null;
    scored.push({ i, score: aiScore - huScore });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function findImmediateWin(candidates, player, size, winLen) {
  for (const i of candidates) {
    board[i] = player;
    const line = checkWinAt(board, i, player, size, winLen);
    board[i] = null;
    if (line) return i;
  }
  return -1;
}

function pickAiOpen(difficulty) {
  if (difficulty === 'easy') return pickAiOpenEasy();
  if (difficulty === 'medium') return pickAiOpenMedium();
  return pickAiOpenHard();
}

function pickAiOpenHard() {
  const size = mode.size, winLen = mode.winLen;
  const candidates = getCandidates(board, size);
  const win = findImmediateWin(candidates, AI, size, winLen);
  if (win >= 0) return win;
  const overlook = Math.random() < 0.1;
  if (!overlook) {
    const block = findImmediateWin(candidates, HUMAN, size, winLen);
    if (block >= 0) return block;
  }
  const scored = scoreCandidates(candidates, size, winLen, 1.1);
  if (overlook && scored.length > 1) return scored[1].i;
  return scored[0].i;
}

function pickAiOpenMedium() {
  const size = mode.size, winLen = mode.winLen;
  const candidates = getCandidates(board, size);
  const win = findImmediateWin(candidates, AI, size, winLen);
  if (win >= 0) return win;
  if (Math.random() > 0.25) {
    const block = findImmediateWin(candidates, HUMAN, size, winLen);
    if (block >= 0) return block;
  }
  const scored = scoreCandidates(candidates, size, winLen, 0.85);
  if (Math.random() < 0.4 && scored.length > 1) {
    const top = scored.slice(0, Math.min(5, scored.length));
    return top[Math.floor(Math.random() * top.length)].i;
  }
  return scored[0].i;
}

function pickAiOpenEasy() {
  const size = mode.size, winLen = mode.winLen;
  const candidates = getCandidates(board, size);
  const win = findImmediateWin(candidates, AI, size, winLen);
  if (win >= 0) return win;
  if (Math.random() < 0.7) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return scoreCandidates(candidates, size, winLen, 0.7)[0].i;
}

// === PvP herní obrazovka ===

function enterPvpGame(state) {
  gameKind = 'pvp';
  pvpRoom = state;
  currentModeName = state.mode;
  mode = { size: state.size, winLen: state.win_len, label: MODES[state.mode].label };

  applyBoardStyle(state.mode, state.size);
  updatePvpScores(state);

  gameOver = state.status !== 'playing';
  renderBoardPvp(state, state.status === 'over' ? state.winning_line : null);

  if (state.status === 'over') {
    showPvpGameOver(state);
  } else {
    gameOverEl.classList.add('hidden');
    updatePvpStatus(state);
  }
  show('game-screen');
}

function updatePvpScores(state) {
  const scoresEl = document.getElementById('pvp-scores');
  if (!state || !state.scores || !currentUser) {
    scoresEl.classList.add('hidden');
    return;
  }
  const me = currentUser.username;
  const opponent = state.players.find(p => p !== me);
  const leftEl  = document.getElementById('pvp-score-left');
  const rightEl = document.getElementById('pvp-score-right');

  leftEl.querySelector('.pvp-score-name').textContent = me;
  leftEl.querySelector('.pvp-score-num').textContent  = state.scores[me] ?? 0;
  leftEl.querySelector('.pvp-score-symbol').textContent = state.symbols?.[me] ? `(${state.symbols[me]})` : '';

  if (opponent) {
    rightEl.querySelector('.pvp-score-name').textContent = opponent;
    rightEl.querySelector('.pvp-score-num').textContent  = state.scores[opponent] ?? 0;
    rightEl.querySelector('.pvp-score-symbol').textContent = state.symbols?.[opponent] ? `(${state.symbols[opponent]})` : '';
    rightEl.classList.remove('hidden');
  } else {
    rightEl.classList.add('hidden');
  }
  scoresEl.classList.remove('hidden');
}

function updatePvpStatus(state) {
  const me = currentUser.username;
  const opponent = state.players.find(p => p !== me) || '…';
  const mySymbol = state.symbols[me] || '?';
  if (state.status === 'playing') {
    if (state.turn === me) {
      statusEl.textContent = `Tvůj tah (${mySymbol}) — soupeř: ${opponent}`;
      startTurnTimer();  // jsem na tahu, spustit připomínku
    } else {
      statusEl.textContent = `Tah soupeře (${opponent})…`;
      cancelTurnTimer();
    }
  } else {
    cancelTurnTimer();
  }
}

function renderBoardPvp(state, winningLine) {
  boardEl.innerHTML = '';
  const me = currentUser.username;
  const myTurn = state.status === 'playing' && state.turn === me;
  const lastMove = state.last_move;
  for (let i = 0; i < state.board.length; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell';
    if (state.board[i]) {
      btn.textContent = state.board[i];
      btn.classList.add(state.board[i].toLowerCase());
      btn.disabled = true;
      if (i === lastMove) btn.classList.add('cell-just-placed');
    } else if (!myTurn) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        socket.emit('make_move', { index: i });
        cancelTurnTimer();  // hned ruším, ať banner okamžitě zmizí
      });
    }
    if (winningLine && winningLine.includes(i)) btn.classList.add('winning');
    boardEl.appendChild(btn);
  }
}

function showPvpGameOver(state) {
  const me = currentUser.username;
  const opponent = state.players.find(p => p !== me) || '?';
  cancelTurnTimer();
  let msg;
  if (state.winner === 'draw') msg = '🤝 Remíza.';
  else if (state.winner === me) msg = '🎉 Vyhrál jsi!';
  else msg = `😞 Vyhrál ${state.winner}.`;
  // Konfety podle symbolu vítěze (X → zprava, O → zleva)
  if (state.winner && state.winner !== 'draw') {
    const winnerSymbol = state.symbols?.[state.winner];
    if (winnerSymbol) celebrateWin(winnerSymbol);
  }
  gameOverText.textContent = msg;
  statusEl.textContent = '';
  gameOverEl.classList.remove('hidden');
  playAgainBtn.classList.remove('hidden');

  const wants = state.wants_rematch || [];
  const iWantRematch = wants.includes(me);
  const opponentWantsRematch = wants.includes(opponent);

  if (iWantRematch) {
    playAgainBtn.textContent = 'Čeká se na soupeře…';
    playAgainBtn.disabled = true;
  } else {
    playAgainBtn.textContent = 'Hrát další hru';
    playAgainBtn.disabled = false;
  }

  const hint = document.getElementById('rematch-hint');
  if (opponentWantsRematch && !iWantRematch) {
    hint.textContent = '👋 Soupeř chce další hru!';
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }

  refreshStats();
}

// =====================================================
// Drawing Competition (DC) — multiplayer s AI hodnocením
// =====================================================

let dcRoom = null;
let pendingDcRoomId = null;
let dcSubmitted = false;
let dcTimerInterval = null;

const dcCanvas = document.getElementById('dc-canvas');
const dcCtx = dcCanvas.getContext('2d');
let dcDrawing = false;
let dcLastX = 0, dcLastY = 0;
let dcColor = '#000000';
let dcBrushSize = 3;

function dcClearCanvas() {
  dcCtx.fillStyle = 'white';
  dcCtx.fillRect(0, 0, dcCanvas.width, dcCanvas.height);
}

function dcGetPos(e) {
  const rect = dcCanvas.getBoundingClientRect();
  const scaleX = dcCanvas.width / rect.width;
  const scaleY = dcCanvas.height / rect.height;
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function dcStartDraw(e) {
  if (dcSubmitted) return;
  e.preventDefault();
  dcDrawing = true;
  const p = dcGetPos(e);
  dcLastX = p.x; dcLastY = p.y;
  // Tečka při krátkém kliknutí
  dcCtx.beginPath();
  dcCtx.arc(p.x, p.y, dcBrushSize / 2, 0, Math.PI * 2);
  dcCtx.fillStyle = dcColor;
  dcCtx.fill();
}

function dcMoveDraw(e) {
  if (!dcDrawing) return;
  e.preventDefault();
  const p = dcGetPos(e);
  dcCtx.beginPath();
  dcCtx.moveTo(dcLastX, dcLastY);
  dcCtx.lineTo(p.x, p.y);
  dcCtx.strokeStyle = dcColor;
  dcCtx.lineWidth = dcBrushSize;
  dcCtx.lineCap = 'round';
  dcCtx.lineJoin = 'round';
  dcCtx.stroke();
  dcLastX = p.x; dcLastY = p.y;
}

function dcEndDraw() { dcDrawing = false; }

dcCanvas.addEventListener('mousedown', dcStartDraw);
dcCanvas.addEventListener('mousemove', dcMoveDraw);
dcCanvas.addEventListener('mouseup', dcEndDraw);
dcCanvas.addEventListener('mouseleave', dcEndDraw);
dcCanvas.addEventListener('touchstart', dcStartDraw, { passive: false });
dcCanvas.addEventListener('touchmove', dcMoveDraw, { passive: false });
dcCanvas.addEventListener('touchend', dcEndDraw);
dcCanvas.addEventListener('touchcancel', dcEndDraw);

dcClearCanvas();  // bílá výchozí plocha

// Výběr barvy
document.querySelectorAll('.dc-color').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dc-color').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dcColor = btn.dataset.color;
  });
});

// Výběr velikosti štětce
document.querySelectorAll('.dc-size').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dc-size').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dcBrushSize = parseInt(btn.dataset.size, 10);
  });
});

// Smazat plochu
document.getElementById('dc-clear-btn').addEventListener('click', () => {
  if (dcSubmitted) return;
  if (confirm('Opravdu smazat celou kresbu?')) dcClearCanvas();
});

// Odeslat kresbu
document.getElementById('dc-submit-btn').addEventListener('click', dcSubmit);

function dcSubmit() {
  if (dcSubmitted) return;
  if (!socket || !socket.connected) return;
  const dataUrl = dcCanvas.toDataURL('image/png');
  socket.emit('dc_submit_drawing', { image: dataUrl });
  dcSubmitted = true;
  const btn = document.getElementById('dc-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Odesláno ✓';
  document.getElementById('dc-status').textContent = 'Čeká se na soupeře…';
}

// === DC timer ===

function startDcTimer(seconds = 90) {
  stopDcTimer();
  let s = seconds;
  const el = document.getElementById('dc-timer');
  el.textContent = s;
  el.classList.remove('urgent');
  dcTimerInterval = setInterval(() => {
    s--;
    if (s < 0) {
      stopDcTimer();
      if (!dcSubmitted) dcSubmit();  // auto-submit při vypršení
      return;
    }
    el.textContent = s;
    if (s <= 10) el.classList.add('urgent');
  }, 1000);
}

function stopDcTimer() {
  if (dcTimerInterval) {
    clearInterval(dcTimerInterval);
    dcTimerInterval = null;
  }
}

// === DC menu + obrazovky ===

document.getElementById('play-dc-btn').addEventListener('click', () => {
  if (!socket) connectSocket();
  const sendCreate = () => socket.emit('dc_create_room');
  if (socket.connected) sendCreate();
  else socket.once('connect', sendCreate);
});

document.getElementById('dc-waiting-cancel-btn').addEventListener('click', () => {
  if (socket) socket.emit('leave_room');
  dcRoom = null; stopDcTimer();
  showMenu();
});

document.getElementById('dc-back-btn').addEventListener('click', () => {
  if (!confirm('Opravdu opustit hru? Tvoje kresba se ztratí.')) return;
  if (socket) socket.emit('leave_room');
  dcRoom = null; stopDcTimer();
  showMenu();
});

document.getElementById('dc-result-back-btn').addEventListener('click', () => {
  if (socket) socket.emit('leave_room');
  dcRoom = null; stopDcTimer();
  showMenu();
});

document.getElementById('dc-next-btn').addEventListener('click', () => {
  if (socket) socket.emit('dc_next_round');
});

document.getElementById('dc-copy-btn').addEventListener('click', async () => {
  const input = document.getElementById('dc-invite-url');
  const url = input.value;
  const fb = document.getElementById('dc-copy-feedback');
  try {
    await navigator.clipboard.writeText(url);
    fb.textContent = '✓ Zkopírováno!';
  } catch {
    input.select();
    try { document.execCommand('copy'); fb.textContent = '✓ Zkopírováno!'; }
    catch { fb.textContent = 'Zkopíruj ručně: ' + url; }
  }
});

function showDcWaiting(state) {
  const url = `${location.origin}${location.pathname}?dcroom=${state.room_id}`;
  document.getElementById('dc-invite-url').value = url;
  document.getElementById('dc-copy-feedback').textContent = '';
  show('dc-waiting-screen');
}

function enterDcGame(state) {
  dcRoom = state;
  dcSubmitted = false;
  dcClearCanvas();
  document.getElementById('dc-theme-text').textContent = state.theme || '…';
  const opponent = state.players.find(p => p !== currentUser.username) || 'soupeř';
  document.getElementById('dc-status').textContent = `Kresli! (soupeř: ${opponent})`;
  const submitBtn = document.getElementById('dc-submit-btn');
  submitBtn.disabled = false;
  submitBtn.textContent = '✓ Odeslat';
  startDcTimer(90);
  show('dc-game-screen');
}

function showDcJudging(state) {
  document.getElementById('dc-status').textContent = '🤖 AI hodnotí kresby…';
  stopDcTimer();
}

function showDcResult(state) {
  stopDcTimer();
  const me = currentUser.username;
  const [pa, pb] = state.players;
  const r = state.result || {};

  document.getElementById('dc-result-theme').textContent = r.theme || state.theme || '…';
  document.getElementById('dc-img-a-label').textContent = `${pa} (A)`;
  document.getElementById('dc-img-b-label').textContent = `${pb} (B)`;
  document.getElementById('dc-img-a').src = (state.submissions && state.submissions[pa]) || '';
  document.getElementById('dc-img-b').src = (state.submissions && state.submissions[pb]) || '';

  let verdict;
  if (!r.winner) verdict = '🤝 Remíza!';
  else if (r.winner === me) verdict = '🎉 Vyhrál jsi!';
  else verdict = `😞 Vyhrál ${r.winner}.`;
  document.getElementById('dc-result-verdict').textContent = verdict;
  document.getElementById('dc-result-reason').textContent = r.duvod ? `„${r.duvod}"` : '';

  document.getElementById('dc-score-a-name').textContent = pa;
  document.getElementById('dc-score-b-name').textContent = pb;
  document.getElementById('dc-score-a-num').textContent = (state.scores || {})[pa] ?? 0;
  document.getElementById('dc-score-b-num').textContent = (state.scores || {})[pb] ?? 0;

  document.querySelectorAll('.dc-image-block').forEach(b => b.classList.remove('winner'));
  if (r.winner === pa) document.getElementById('dc-img-a').parentElement.classList.add('winner');
  if (r.winner === pb) document.getElementById('dc-img-b').parentElement.classList.add('winner');

  const wants = state.wants_next || [];
  const opponent = state.players.find(p => p !== me);
  const iWant = wants.includes(me);
  const opponentWants = opponent && wants.includes(opponent);
  const nextBtn = document.getElementById('dc-next-btn');
  const hint = document.getElementById('dc-next-hint');
  if (iWant) {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Čeká se na soupeře…';
  } else {
    nextBtn.disabled = false;
    nextBtn.textContent = 'Hrát další kolo';
  }
  hint.textContent = (opponentWants && !iWant) ? '👋 Soupeř chce další kolo!' : '';

  show('dc-result-screen');
}

// Drawing Competition socket listeners — registrují se po prvním connectu
function attachDcSocketListeners() {
  if (!socket || socket._dcListenersAttached) return;
  socket._dcListenersAttached = true;

  socket.on('dc_room_state', state => {
    dcRoom = state;
    if (state.status === 'waiting') {
      showDcWaiting(state);
    } else if (state.status === 'drawing') {
      // Pokud už jsme v game screen, jen znova nastavit (nové kolo)
      if (document.getElementById('dc-game-screen').classList.contains('hidden')) {
        enterDcGame(state);
      } else {
        // Re-init pro další kolo
        enterDcGame(state);
      }
    } else if (state.status === 'judging') {
      showDcJudging(state);
    } else if (state.status === 'over') {
      showDcResult(state);
    }
  });

  socket.on('dc_opponent_left', () => {
    const isDcScreen = !document.getElementById('dc-game-screen').classList.contains('hidden')
                    || !document.getElementById('dc-waiting-screen').classList.contains('hidden')
                    || !document.getElementById('dc-result-screen').classList.contains('hidden');
    if (!isDcScreen) return;
    alert('😶 Soupeř opustil hru.');
    dcRoom = null; stopDcTimer();
    showMenu();
  });
}

// Připojit DC listenery vždy, když se vytvoří socket
const _origConnectSocket = connectSocket;
connectSocket = function() {
  _origConnectSocket.apply(this, arguments);
  attachDcSocketListeners();
};

// === Inicializace ===

(function init() {
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  if (roomParam) pendingRoomId = roomParam.toUpperCase();
  const dcroomParam = params.get('dcroom');
  if (dcroomParam) pendingDcRoomId = dcroomParam.toUpperCase();

  playAgainBtn.textContent = 'Hrát znovu';

  api('/api/me').then(data => {
    currentUser = data;
    onLoginSuccess();
  }).catch(() => {
    show('auth-screen');
  });
})();
