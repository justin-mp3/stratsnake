require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const vm = require('vm');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const client = new Anthropic();

app.use(express.static('public'));

// ─── Constants ───────────────────────────────────────────────────────────────
const GRID = 40;
const TICK_MS = 100;
const INITIAL_LENGTH = 5;
const FOOD_COUNT = 30;
const RESPAWN_DELAY = 3000;
const REPROMPT_COOLDOWN = 10000;
const DIRS = ['up', 'down', 'left', 'right'];
const DELTAS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITES = { up: 'down', down: 'up', left: 'right', right: 'left' };

// ─── State ───────────────────────────────────────────────────────────────────
const state = { snakes: {}, food: [], tick: 0 };

// ─── Bot definitions ──────────────────────────────────────────────────────────
const BOTS = [
  { name: 'Chomper', strategy: 'always chase nearest food aggressively', color: '#f783ac' },
  { name: 'Ghost',   strategy: 'hug walls and avoid all other snakes',   color: '#69db7c' },
  { name: 'Blade',   strategy: 'chase and cut off smaller snakes',       color: '#ffa94d' },
];

// ─── Utility ─────────────────────────────────────────────────────────────────
function randomInt(n) { return Math.floor(Math.random() * n); }

function randomColor() {
  const colors = ['#4dabf7', '#a9e34b', '#e599f7', '#ffd43b', '#74c0fc', '#63e6be'];
  return colors[randomInt(colors.length)];
}

function randomSafeSpawn() {
  const occupied = new Set();
  for (const s of Object.values(state.snakes)) {
    if (s.alive) for (const seg of s.body) occupied.add(`${seg.x},${seg.y}`);
  }
  let attempts = 0;
  while (attempts++ < 200) {
    const x = randomInt(GRID - 10) + 5;
    const y = randomInt(GRID - 10) + 5;
    let clear = true;
    for (let i = 0; i < INITIAL_LENGTH; i++) {
      if (occupied.has(`${x - i},${y}`)) { clear = false; break; }
    }
    if (clear) return { x, y };
  }
  return { x: randomInt(GRID), y: randomInt(GRID) };
}

function makeSnake(id, name, color, isBot = false) {
  const pos = randomSafeSpawn();
  return {
    id,
    name,
    body: Array.from({ length: INITIAL_LENGTH }, (_, i) => ({ x: pos.x - i, y: pos.y })),
    direction: 'right',
    alive: true,
    score: 0,
    kills: 0,
    strategy: 'default',
    decideFn: null,
    lastReprompt: 0,
    color: color || randomColor(),
    deaths: 0,
    isBot,
  };
}

function replenishFood() {
  const occupied = new Set();
  for (const s of Object.values(state.snakes)) {
    if (s.alive) for (const seg of s.body) occupied.add(`${seg.x},${seg.y}`);
  }
  for (const f of state.food) occupied.add(`${f.x},${f.y}`);

  while (state.food.length < FOOD_COUNT) {
    const x = randomInt(GRID), y = randomInt(GRID);
    if (!occupied.has(`${x},${y}`)) {
      const value = Math.random() < 0.1 ? 3 : 1;
      state.food.push({ x, y, value });
      occupied.add(`${x},${y}`);
    }
  }
}

// ─── Default AI ───────────────────────────────────────────────────────────────
function defaultDecide(me, snakes, food) {
  const head = me.head || me.body[0];
  const occupied = new Set();
  for (const s of snakes) for (const seg of s.body) occupied.add(`${seg.x},${seg.y}`);
  for (const seg of me.body) occupied.add(`${seg.x},${seg.y}`);

  const safe = DIRS.filter(d => {
    if (d === OPPOSITES[me.direction]) return false;
    const [dx, dy] = DELTAS[d];
    const nx = (head.x + dx + GRID) % GRID;
    const ny = (head.y + dy + GRID) % GRID;
    return !occupied.has(`${nx},${ny}`);
  });

  if (!safe.length) return DIRS.find(d => d !== OPPOSITES[me.direction]) || 'up';
  if (!food.length) return safe[0];

  let best = safe[0], bd = Infinity;
  for (const d of safe) {
    const [dx, dy] = DELTAS[d];
    const nx = (head.x + dx + GRID) % GRID;
    const ny = (head.y + dy + GRID) % GRID;
    for (const f of food) {
      const dist = Math.abs(nx - f.x) + Math.abs(ny - f.y);
      if (dist < bd) { bd = dist; best = d; }
    }
  }
  return best;
}

// ─── AI Codegen ───────────────────────────────────────────────────────────────
async function generateDecideFn(strategy) {
  const systemPrompt = `You are a game AI code generator for a slither.io-style game.
Generate ONLY a JavaScript function body (no function declaration, no markdown fences).
The following constants are ALREADY declared and available — do NOT redeclare them:
  GRID = 40 (grid wraps at edges)
  DIRS = ['up','down','left','right']
  DELTAS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }
  OPPOSITES = { up:'down', down:'up', left:'right', right:'left' }
The function receives:
  - me: { head: {x,y}, body: [{x,y}], direction: string, score: number, length: number }
  - snakes: [{ head: {x,y}, body: [{x,y}], direction: string, length: number, id: string }]
  - food: [{ x: number, y: number, value: number }]
Return a string: "up" | "down" | "left" | "right"
Rules:
- NEVER return the opposite of current direction (that causes instant death)
- Always end with a return statement that returns a direction string
- Keep it under 40 lines
- No async, no fetch, no require, no setTimeout, no global state
- Use only Math, Array, Object — no other globals
- Do NOT redeclare GRID, DIRS, DELTAS, or OPPOSITES
- Do NOT redeclare or shadow the function parameters: me, snakes, food`;

  const userPrompt = `Strategy: "${strategy}"
Generate the function body only. It must end with a return statement or expression that is a direction string.`;

  const response = await Promise.race([
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API timeout after 5s')), 5000)
    ),
  ]);

  let code = response.content[0].text.trim();
  // Strip any accidental markdown fences
  code = code.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();
  // Remove any redeclarations of constants/params we inject so there's no conflict
  for (const name of ['GRID', 'DIRS', 'DELTAS', 'OPPOSITES', 'me', 'snakes', 'food']) {
    code = code.replace(new RegExp(`^[ \\t]*(?:const|let|var)\\s+${name}\\b[^;\\n]*;?[ \\t]*\\n?`, 'gm'), '');
  }

  const wrapped = `(function(me, snakes, food) {
    const GRID = 40;
    const DIRS = ['up','down','left','right'];
    const DELTAS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
    const OPPOSITES = { up:'down', down:'up', left:'right', right:'left' };
    ${code}
  })`;

  // Compile — throws on syntax error
  let script, fn;
  try {
    script = new vm.Script(wrapped);
    fn = script.runInNewContext({ Math, Array, Object }, { timeout: 50 });
  } catch (compileErr) {
    console.error(`[codegen compile error] ${compileErr.message}\n--- generated code ---\n${code}\n--- end ---`);
    throw compileErr;
  }

  // Smoke test
  const testMe = {
    head: { x: 5, y: 5 },
    body: [{ x: 5, y: 5 }, { x: 4, y: 5 }],
    direction: 'right',
    score: 0,
    length: 2,
  };
  const result = fn(testMe, [], [{ x: 10, y: 10, value: 1 }]);
  if (!DIRS.includes(result)) throw new Error(`Invalid direction returned: "${result}"`);

  return { fn, code };
}

// ─── Safe decide wrapper ──────────────────────────────────────────────────────
function safeDecide(snake, allSnakes, food) {
  if (!snake.decideFn) return defaultDecide(snake, allSnakes, food);
  try {
    const others = allSnakes.filter(s => s.id !== snake.id && s.alive);
    const meArg = {
      head: snake.body[0],
      body: snake.body,
      direction: snake.direction,
      score: snake.score,
      length: snake.body.length,
    };
    const snakesArg = others.map(s => ({
      head: s.body[0],
      body: s.body,
      direction: s.direction,
      length: s.body.length,
      id: s.id,
    }));

    const ctx = vm.createContext({ Math, Array, Object });
    // Serialize args to avoid passing live references into sandbox
    const argsJson = JSON.stringify([meArg, snakesArg, food]);
    const code = `(${snake.decideFn.toString()})(
      JSON.parse(${JSON.stringify(argsJson)})[0],
      JSON.parse(${JSON.stringify(argsJson)})[1],
      JSON.parse(${JSON.stringify(argsJson)})[2]
    )`;
    const result = vm.runInContext(code, ctx, { timeout: 2 });

    if (!DIRS.includes(result)) return defaultDecide(snake, allSnakes, food);
    if (result === OPPOSITES[snake.direction]) return defaultDecide(snake, allSnakes, food);
    return result;
  } catch {
    return defaultDecide(snake, allSnakes, food);
  }
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function stepSnakes() {
  const allSnakes = Object.values(state.snakes);
  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const dir = safeDecide(snake, allSnakes, state.food);
    snake.direction = dir;
    const [dx, dy] = DELTAS[dir];
    const head = snake.body[0];
    const newHead = {
      x: (head.x + dx + GRID) % GRID,
      y: (head.y + dy + GRID) % GRID,
    };
    snake.body.unshift(newHead);
    // Pop tail unless growing (growing handled in checkFood by not popping)
    snake._shouldGrow ? (snake._shouldGrow = false) : snake.body.pop();
  }
}

function checkCollisions() {
  const allSnakes = Object.values(state.snakes);
  const dying = new Set();

  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const head = snake.body[0];

    // Check head vs all body segments
    for (const other of allSnakes) {
      if (!other.alive) continue;
      const start = (other.id === snake.id) ? 1 : 0; // skip own head
      for (let i = start; i < other.body.length; i++) {
        if (head.x === other.body[i].x && head.y === other.body[i].y) {
          dying.add(snake.id);
          break;
        }
      }
    }
  }

  // Head-on-head collisions: check pairs
  for (let i = 0; i < allSnakes.length; i++) {
    for (let j = i + 1; j < allSnakes.length; j++) {
      const a = allSnakes[i], b = allSnakes[j];
      if (!a.alive || !b.alive) continue;
      if (a.body[0].x === b.body[0].x && a.body[0].y === b.body[0].y) {
        if (a.body.length <= b.body.length) dying.add(a.id);
        if (b.body.length <= a.body.length) dying.add(b.id);
      }
    }
  }

  for (const id of dying) {
    const snake = state.snakes[id];
    if (snake && snake.alive) {
      // Find killer (who's head is at this position, not self)
      let killer = null;
      for (const other of allSnakes) {
        if (other.id === id || !other.alive) continue;
        for (const seg of other.body) {
          if (seg.x === snake.body[0].x && seg.y === snake.body[0].y) {
            killer = other;
            break;
          }
        }
        if (killer) break;
      }
      killSnake(snake, killer);
    }
  }
}

function checkFood() {
  const allSnakes = Object.values(state.snakes);
  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const head = snake.body[0];
    for (let i = state.food.length - 1; i >= 0; i--) {
      const f = state.food[i];
      if (head.x === f.x && head.y === f.y) {
        state.food.splice(i, 1);
        snake.score += f.value;
        snake._shouldGrow = true;
        break;
      }
    }
  }
}

function killSnake(snake, killer) {
  snake.alive = false;
  snake.deaths = (snake.deaths || 0) + 1;

  // Drop food at every 3rd segment
  for (let i = 0; i < snake.body.length; i += 3) {
    const seg = snake.body[i];
    state.food.push({ x: seg.x, y: seg.y, value: 2 });
  }

  if (killer) {
    killer.kills++;
    // Broadcast kill event
    io.emit('kill_feed', { killer: killer.name, victim: snake.name });
  }

  if (!snake.isBot) {
    io.to(snake.id).emit('you_died', {
      killer: killer?.name || 'the wall',
      score: snake.score,
    });
  }

  setTimeout(() => respawnSnake(snake), RESPAWN_DELAY);
}

function respawnSnake(snake) {
  if (!state.snakes[snake.id]) return; // disconnected

  const pos = randomSafeSpawn();
  snake.body = Array.from({ length: INITIAL_LENGTH }, (_, i) => ({ x: pos.x - i, y: pos.y }));
  snake.direction = 'right';
  snake.alive = true;
  snake.score = 0;
  snake._shouldGrow = false;

  // Bots: regenerate strategy after 3 deaths
  if (snake.isBot && snake.deaths >= 3) {
    snake.deaths = 0;
    generateDecideFn(snake.strategy)
      .then(({ fn }) => { snake.decideFn = fn; })
      .catch(() => {});
  }
}

function serializeState() {
  return {
    tick: state.tick,
    snakes: Object.values(state.snakes).map(s => ({
      id: s.id,
      name: s.name,
      body: s.body,
      alive: s.alive,
      score: s.score,
      kills: s.kills,
      strategy: s.strategy,
      color: s.color,
      isBot: s.isBot,
    })),
    food: state.food,
  };
}

// ─── Game loop ────────────────────────────────────────────────────────────────
setInterval(() => {
  stepSnakes();
  checkCollisions();
  checkFood();
  replenishFood();
  state.tick++;
  io.emit('state', serializeState());
}, TICK_MS);

// ─── Socket handling ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] connect ${socket.id}`);

  socket.on('join', ({ name, color }) => {
    const safeName = String(name || 'Player').slice(0, 16);
    const snake = makeSnake(socket.id, safeName, color);
    state.snakes[socket.id] = snake;
    socket.emit('constants', { GRID, TICK_MS, REPROMPT_COOLDOWN });
    console.log(`[join] ${safeName} (${socket.id})`);
  });

  socket.on('submit_strategy', async ({ strategy }) => {
    const snake = state.snakes[socket.id];
    if (!snake) return;

    const now = Date.now();
    const remaining = REPROMPT_COOLDOWN - (now - snake.lastReprompt);
    if (remaining > 0) {
      socket.emit('strategy_error', { msg: `Cooldown: ${Math.ceil(remaining / 1000)}s remaining` });
      return;
    }

    const trimmed = String(strategy).slice(0, 50).trim();
    if (!trimmed) return;

    socket.emit('strategy_compiling', { strategy: trimmed });
    console.log(`[strategy] ${snake.name}: "${trimmed}"`);

    try {
      const { fn, code } = await generateDecideFn(trimmed);
      snake.decideFn = fn;
      snake.decideFnCode = code;
      snake.strategy = trimmed;
      snake.lastReprompt = Date.now();
      socket.emit('strategy_active', { strategy: trimmed, code });
      console.log(`[strategy] ${snake.name}: deployed`);
    } catch (e) {
      console.error(`[strategy error] ${snake.name}:`, e.message);
      socket.emit('strategy_error', { msg: e.message.slice(0, 80) });
    }
  });

  socket.on('disconnect', () => {
    delete state.snakes[socket.id];
    console.log(`[-] disconnect ${socket.id}`);
  });
});

// ─── Bot initialization ───────────────────────────────────────────────────────
async function initBots() {
  for (const bot of BOTS) {
    const id = `bot_${bot.name.toLowerCase()}`;
    const snake = makeSnake(id, bot.name, bot.color, true);
    snake.strategy = bot.strategy;
    state.snakes[id] = snake;

    try {
      const { fn } = await generateDecideFn(bot.strategy);
      snake.decideFn = fn;
      console.log(`[bot] ${bot.name} strategy deployed: "${bot.strategy}"`);
    } catch (e) {
      console.warn(`[bot] ${bot.name} using default AI: ${e.message}`);
    }
  }
  replenishFood();
}

// ─── Benchmark ───────────────────────────────────────────────────────────────
const BENCH_STRATEGIES = [
  { name: 'FoodRacer',    strategy: 'sprint to nearest food, ignore snakes' },
  { name: 'Coward',       strategy: 'avoid all snakes at all costs, survive' },
  { name: 'WallHugger',   strategy: 'hug walls and collect edge food' },
  { name: 'Assassin',     strategy: 'hunt and kill the smallest snake nearby' },
  { name: 'Cluster',      strategy: 'find dense food clusters and camp them' },
  { name: 'Cutoff',       strategy: 'cut off escape routes of nearby snakes' },
  { name: 'Zigzag',       strategy: 'zigzag pattern to cover maximum ground' },
  { name: 'BigGameHuntr', strategy: 'chase the highest-scoring snake' },
  { name: 'Opportunist',  strategy: 'eat food left by dead snakes' },
  { name: 'Spiraler',     strategy: 'spiral outward from spawn eating food' },
];

function simMakeSnake(id, name, color, grid) {
  const occupied = new Set();
  let pos = { x: 5 + Math.floor(Math.random() * (grid - 10)), y: 5 + Math.floor(Math.random() * (grid - 10)) };
  return {
    id, name, color,
    body: Array.from({ length: 5 }, (_, i) => ({ x: pos.x - i, y: pos.y })),
    direction: 'right',
    alive: true,
    score: 0,
    kills: 0,
    deaths: 0,
    decideFn: null,
    _shouldGrow: false,
  };
}

function simDefaultDecide(me, allSnakes, foodArr, G) {
  const head = me.body[0];
  const occ = new Set();
  for (const s of allSnakes) for (const seg of s.body) occ.add(`${seg.x},${seg.y}`);
  for (const seg of me.body) occ.add(`${seg.x},${seg.y}`);
  const safe = DIRS.filter(d => {
    if (d === OPPOSITES[me.direction]) return false;
    const [dx, dy] = DELTAS[d];
    const nx = (head.x + dx + G) % G, ny = (head.y + dy + G) % G;
    return !occ.has(`${nx},${ny}`);
  });
  if (!safe.length) return DIRS.find(d => d !== OPPOSITES[me.direction]) || 'up';
  if (!foodArr.length) return safe[0];
  let best = safe[0], bd = Infinity;
  for (const d of safe) {
    const [dx, dy] = DELTAS[d];
    const nx = (head.x + dx + G) % G, ny = (head.y + dy + G) % G;
    for (const f of foodArr) {
      const dist = Math.abs(nx - f.x) + Math.abs(ny - f.y);
      if (dist < bd) { bd = dist; best = d; }
    }
  }
  return best;
}

function simSafeDecide(snake, allSnakes, foodArr, G) {
  if (!snake.decideFn) return simDefaultDecide(snake, allSnakes, foodArr, G);
  try {
    const meArg = { head: snake.body[0], body: snake.body, direction: snake.direction, score: snake.score, length: snake.body.length };
    const snakesArg = allSnakes.filter(s => s.id !== snake.id && s.alive).map(s => ({ head: s.body[0], body: s.body, direction: s.direction, length: s.body.length, id: s.id }));
    const ctx = vm.createContext({ Math, Array, Object });
    const argsJson = JSON.stringify([meArg, snakesArg, foodArr]);
    const result = vm.runInContext(
      `(${snake.decideFn.toString()})(JSON.parse(${JSON.stringify(argsJson)})[0],JSON.parse(${JSON.stringify(argsJson)})[1],JSON.parse(${JSON.stringify(argsJson)})[2])`,
      ctx, { timeout: 2 }
    );
    if (!DIRS.includes(result) || result === OPPOSITES[snake.direction]) return simDefaultDecide(snake, allSnakes, foodArr, G);
    return result;
  } catch {
    return simDefaultDecide(snake, allSnakes, foodArr, G);
  }
}

function runSimulation(contestants, ticks = 2000, G = 40, foodCount = 30) {
  // Build snakes
  const colors = ['#f783ac','#69db7c','#ffa94d','#4dabf7','#a9e34b','#e599f7','#ffd43b','#74c0fc','#63e6be','#ff8787'];
  const snakes = contestants.map((c, i) => {
    const s = simMakeSnake(`sim_${i}`, c.name, colors[i % colors.length], G);
    s.decideFn = c.fn;
    return s;
  });

  // Seed food
  const foodArr = [];
  const occ = new Set();
  while (foodArr.length < foodCount) {
    const x = Math.floor(Math.random() * G), y = Math.floor(Math.random() * G);
    if (!occ.has(`${x},${y}`)) { foodArr.push({ x, y, value: 1 }); occ.add(`${x},${y}`); }
  }

  // Track stats
  const stats = contestants.map((c, i) => ({ name: c.name, strategy: c.strategy, score: 0, kills: 0, survivalTicks: 0, deaths: 0 }));

  for (let tick = 0; tick < ticks; tick++) {
    // Step
    for (const snake of snakes) {
      if (!snake.alive) continue;
      const dir = simSafeDecide(snake, snakes, foodArr, G);
      snake.direction = dir;
      const [dx, dy] = DELTAS[dir];
      const head = snake.body[0];
      const newHead = { x: (head.x + dx + G) % G, y: (head.y + dy + G) % G };
      snake.body.unshift(newHead);
      snake._shouldGrow ? (snake._shouldGrow = false) : snake.body.pop();
    }

    // Food
    for (const snake of snakes) {
      if (!snake.alive) continue;
      const head = snake.body[0];
      for (let i = foodArr.length - 1; i >= 0; i--) {
        if (foodArr[i].x === head.x && foodArr[i].y === head.y) {
          snake.score++;
          snake._shouldGrow = true;
          stats[snakes.indexOf(snake)].score++;
          foodArr.splice(i, 1);
          break;
        }
      }
    }

    // Collisions
    const dying = new Set();
    for (const snake of snakes) {
      if (!snake.alive) continue;
      const head = snake.body[0];
      for (const other of snakes) {
        if (!other.alive) continue;
        const start = other.id === snake.id ? 1 : 0;
        for (let i = start; i < other.body.length; i++) {
          if (head.x === other.body[i].x && head.y === other.body[i].y) { dying.add(snake.id); break; }
        }
      }
    }
    for (let i = 0; i < snakes.length; i++) {
      for (let j = i + 1; j < snakes.length; j++) {
        const a = snakes[i], b = snakes[j];
        if (!a.alive || !b.alive) continue;
        if (a.body[0].x === b.body[0].x && a.body[0].y === b.body[0].y) {
          if (a.body.length <= b.body.length) dying.add(a.id);
          if (b.body.length <= a.body.length) dying.add(b.id);
        }
      }
    }
    for (const id of dying) {
      const snake = snakes.find(s => s.id === id);
      if (!snake || !snake.alive) continue;
      snake.alive = false;
      stats[snakes.indexOf(snake)].deaths++;
      // Drop food
      for (let i = 0; i < snake.body.length; i += 3) foodArr.push({ x: snake.body[i].x, y: snake.body[i].y, value: 1 });
      // Credit killer
      for (const other of snakes) {
        if (!other.alive || other.id === id) continue;
        for (const seg of other.body) {
          if (seg.x === snake.body[0].x && seg.y === snake.body[0].y) {
            other.kills++;
            stats[snakes.indexOf(other)].kills++;
            break;
          }
        }
      }
      // Respawn after 50 ticks (simulate RESPAWN_DELAY)
      const si = snakes.indexOf(snake);
      setTimeout(() => {
        if (!snake) return;
        const x = 5 + Math.floor(Math.random() * (G - 10)), y = 5 + Math.floor(Math.random() * (G - 10));
        snake.body = Array.from({ length: 5 }, (_, k) => ({ x: x - k, y }));
        snake.direction = 'right';
        snake.alive = true;
        snake._shouldGrow = false;
      }, 0); // immediate respawn in simulation (no delay)
      snake.alive = true; // respawn immediately in fast sim
      const x = 5 + Math.floor(Math.random() * (G - 10)), y = 5 + Math.floor(Math.random() * (G - 10));
      snake.body = Array.from({ length: 5 }, (_, k) => ({ x: x - k, y }));
      snake.direction = 'right';
    }

    // Replenish food
    while (foodArr.length < foodCount) {
      const x = Math.floor(Math.random() * G), y = Math.floor(Math.random() * G);
      foodArr.push({ x, y, value: 1 });
    }

    // Survival ticks
    for (let i = 0; i < snakes.length; i++) {
      if (snakes[i].alive) stats[i].survivalTicks++;
    }
  }

  // Final scoring: food*1 + kills*5 + survivalTicks/40
  return stats.map(s => ({
    ...s,
    finalScore: s.score + s.kills * 5 + Math.round(s.survivalTicks / 40),
  })).sort((a, b) => b.finalScore - a.finalScore);
}

app.get('/benchmark', async (req, res) => {
  console.log('[benchmark] starting — generating 10 strategies...');
  res.setHeader('Content-Type', 'application/json');

  try {
    const results = await Promise.allSettled(
      BENCH_STRATEGIES.map(c => generateDecideFn(c.strategy).then(({ fn }) => ({ ...c, fn })))
    );

    const contestants = results.map((r, i) => ({
      name: BENCH_STRATEGIES[i].name,
      strategy: BENCH_STRATEGIES[i].strategy,
      fn: r.status === 'fulfilled' ? r.value.fn : null,
      genOk: r.status === 'fulfilled',
    }));

    console.log('[benchmark] all strategies generated, running simulation (2000 ticks)...');
    const ranking = runSimulation(contestants, 2000);
    console.log('[benchmark] done');

    res.json({ ok: true, ticks: 2000, ranking });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Slither Prompt Arena running on http://localhost:${PORT}`);
  await initBots();
});
