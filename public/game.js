// ─── Setup ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const CELL = 16; // pixels per grid tile (640 / 40)

let socket = null;
let gameState = null;
let myId = null;
let myColor = '#4dabf7';
let cooldownEnd = 0;
let joined = false;
let GRID = 40;
let killFeedEntries = [];
let cooldownInterval = null;

// ─── Color picker ─────────────────────────────────────────────────────────────
document.querySelectorAll('.color-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
    swatch.classList.add('selected');
    myColor = swatch.dataset.color;
  });
});
document.querySelector('.color-swatch').classList.add('selected');

// ─── Join ─────────────────────────────────────────────────────────────────────
document.getElementById('join-btn').addEventListener('click', joinGame);
document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinGame();
});

function joinGame() {
  const name = document.getElementById('name-input').value.trim() || 'Player';
  document.getElementById('join-overlay').classList.add('hidden');
  document.getElementById('deploy-btn').disabled = false;
  joined = true;

  socket = io();
  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join', { name, color: myColor });
  });

  socket.on('constants', ({ GRID: g }) => { GRID = g; });
  socket.on('state', onState);
  socket.on('strategy_compiling', onCompiling);
  socket.on('strategy_active', onActive);
  socket.on('strategy_error', onError);
  socket.on('you_died', onDied);
  socket.on('kill_feed', onKillFeed);

  // Code toggle button
  document.getElementById('code-toggle').addEventListener('click', () => {
    const pre = document.getElementById('fn-code');
    const btn = document.getElementById('code-toggle');
    const collapsed = pre.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▶ show' : '▼ hide';
  });
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
function onState(s) {
  gameState = s;
  updateLeaderboard(s);
}

function onCompiling({ strategy }) {
  setStatus('compiling', `⟳ compiling "${strategy}"…`);
}

function onActive({ strategy, code }) {
  document.getElementById('current-strategy').textContent = `"${strategy}"`;
  setStatus('active', '✓ active');
  cooldownEnd = Date.now() + 10000;
  document.getElementById('deploy-btn').disabled = true;
  startCooldown();
  if (code) showCode(code);
}

function showCode(rawCode) {
  const pre = document.getElementById('fn-code');
  // Minimal syntax highlighting
  const escaped = rawCode
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const highlighted = escaped
    .replace(/(\/\/[^\n]*)/g, '<span class="cmt">$1</span>')
    .replace(/\b(const|let|var|function|return|if|else|for|of|in|while|break|continue|new|true|false|null|undefined)\b/g, '<span class="kw">$1</span>')
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="str">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
  pre.innerHTML = highlighted;
  pre.classList.remove('collapsed');
  document.getElementById('code-toggle').textContent = '▼ hide';
}

function onError({ msg }) {
  setStatus('error', `✗ ${msg}`);
  document.getElementById('deploy-btn').disabled = false;
}

function onDied({ killer, score }) {
  setStatus('dead', `💀 Eaten by ${killer}. Score: ${score}. Respawning…`);
  setTimeout(() => {
    document.getElementById('strategy-input').value = '';
    document.getElementById('char-count').textContent = '0 / 50';
    document.getElementById('char-count').className = '';
    setStatus('', 'Enter a new strategy to redeploy');
  }, 2500);
}

function onKillFeed({ killer, victim }) {
  killFeedEntries.unshift({ killer, victim });
  if (killFeedEntries.length > 6) killFeedEntries.pop();
  renderKillFeed();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(cls, text) {
  const el = document.getElementById('strategy-status');
  el.className = cls;
  el.textContent = text;
}

function startCooldown() {
  clearInterval(cooldownInterval);
  const bar = document.getElementById('cooldown-bar');
  const btn = document.getElementById('deploy-btn');

  cooldownInterval = setInterval(() => {
    const remaining = cooldownEnd - Date.now();
    if (remaining <= 0) {
      clearInterval(cooldownInterval);
      bar.style.width = '0%';
      btn.disabled = false;
      if (document.getElementById('strategy-status').className === 'active') {
        setStatus('', 'Ready to redeploy');
      }
    } else {
      bar.style.width = `${(remaining / 10000) * 100}%`;
    }
  }, 100);
}

function updateLeaderboard(s) {
  const sorted = [...s.snakes].sort((a, b) => b.score - a.score).slice(0, 10);
  const lb = document.getElementById('leaderboard');
  lb.innerHTML = sorted.map((snake, i) => {
    const isMe = snake.id === myId;
    const dead = !snake.alive ? ' dead' : '';
    return `<div class="lb-row${isMe ? ' me' : ''}${dead}">
      <span>${i + 1}</span>
      <div class="lb-dot" style="background:${snake.color}"></div>
      <span class="lb-name">${esc(snake.name)}${snake.isBot ? ' 🤖' : ''}</span>
      <span class="lb-score">${snake.score}</span>
    </div>`;
  }).join('');
}

function renderKillFeed() {
  const el = document.getElementById('kill-feed');
  el.innerHTML = killFeedEntries.map(e =>
    `<div class="kf-entry"><span class="killer">${esc(e.killer)}</span> ate <span class="victim">${esc(e.victim)}</span></div>`
  ).join('');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Strategy input ───────────────────────────────────────────────────────────
const stratInput = document.getElementById('strategy-input');
const charCount = document.getElementById('char-count');
const deployBtn = document.getElementById('deploy-btn');
const stratPreset = document.getElementById('strategy-preset');

stratPreset.addEventListener('change', () => {
  const val = stratPreset.value;
  if (!val) return;
  stratInput.value = val;
  const len = val.length;
  charCount.textContent = `${len} / 50`;
  charCount.className = len >= 50 ? 'at-limit' : len >= 40 ? 'near-limit' : '';
  stratInput.focus();
});

stratInput.addEventListener('input', () => {
  const len = stratInput.value.length;
  charCount.textContent = `${len} / 50`;
  charCount.className = len >= 50 ? 'at-limit' : len >= 40 ? 'near-limit' : '';
  // Deselect preset if user is typing their own
  if (stratPreset.value !== stratInput.value) stratPreset.value = '';
});

stratInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    deployStrategy();
  }
});

deployBtn.addEventListener('click', deployStrategy);

function deployStrategy() {
  if (!socket || !joined) return;
  const s = stratInput.value.trim();
  if (!s) return;
  if (Date.now() < cooldownEnd) return;
  socket.emit('submit_strategy', { strategy: s });
}

// ─── Canvas render ────────────────────────────────────────────────────────────
function render() {
  requestAnimationFrame(render);

  ctx.fillStyle = '#0a0e1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!gameState) {
    ctx.fillStyle = 'rgba(77,171,247,0.2)';
    ctx.font = '14px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('Connecting…', canvas.width / 2, canvas.height / 2);
    return;
  }

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= GRID; i++) {
    ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(canvas.width, i * CELL); ctx.stroke();
  }

  // Food
  for (const f of gameState.food) {
    const cx = f.x * CELL + CELL / 2;
    const cy = f.y * CELL + CELL / 2;
    const r = f.value > 1 ? 4.5 : 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = f.value > 1 ? '#ffd43b' : `hsl(${f.x * 9 + f.y * 7}, 70%, 65%)`;
    ctx.fill();
    if (f.value > 1) {
      ctx.strokeStyle = 'rgba(255,212,59,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Snakes (dead first, then alive so alive render on top)
  const sorted = [...gameState.snakes].sort((a, b) => Number(b.alive) - Number(a.alive));
  for (const snake of sorted) {
    if (!snake.alive) {
      // Draw faded ghost
      ctx.globalAlpha = 0.2;
      drawSnake(snake, false);
      ctx.globalAlpha = 1;
    } else {
      const isMe = snake.id === myId;
      drawSnake(snake, isMe);
    }
  }
}

function drawSnake(snake, isMe) {
  const len = snake.body.length;

  // Glow for own snake
  if (isMe) {
    const head = snake.body[0];
    ctx.shadowBlur = 12;
    ctx.shadowColor = snake.color;
  }

  for (let i = 0; i < len; i++) {
    const seg = snake.body[i];
    const alpha = i === 0 ? 1 : Math.max(0.3, 0.9 - (i / len) * 0.6);
    const color = i === 0 ? lighten(snake.color, 0.25) : snake.color;

    ctx.fillStyle = hexToRgba(color, alpha);
    roundRect(ctx, seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2, 2);
    ctx.fill();
  }

  ctx.shadowBlur = 0;

  // Name tag above head
  if (snake.body.length > 0) {
    const head = snake.body[0];
    ctx.font = isMe ? 'bold 11px Courier New' : '10px Courier New';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#fff' : 'rgba(200,214,229,0.7)';
    const label = snake.name + (snake.isBot ? ' 🤖' : '');
    ctx.fillText(label, head.x * CELL + CELL / 2, head.y * CELL - 2);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function lighten(hex, amount) {
  const r = Math.min(255, parseInt(hex.slice(1,3), 16) + Math.round(255 * amount));
  const g = Math.min(255, parseInt(hex.slice(3,5), 16) + Math.round(255 * amount));
  const b = Math.min(255, parseInt(hex.slice(5,7), 16) + Math.round(255 * amount));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

render();
