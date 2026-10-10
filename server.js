// ACM PDEU QUIZ — real-time quiz server. The server is the source of truth:
// it runs the timer, scores answers, and never sends the correct answer to phones before the reveal.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 500;
const LATENCY_GRACE_MS = 500; // answers in flight when the timer hits 0 still count
const AUTO_REVEAL_MS = 5000;
const AUTO_BOARD_MS = 6000;
const GAME_TTL_MS = 3 * 60 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

// ponytail: in-memory, single instance. Add the socket.io Redis adapter + a store if you ever run >1 server.
const games = new Map();

// ---------- helpers ----------
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};
const id = () => crypto.randomBytes(12).toString('hex');
const hostRoom = (g) => `host:${g.pin}`;

function newPin() {
  let pin;
  do pin = String(crypto.randomInt(100000, 1000000));
  while (games.has(pin));
  return pin;
}

function cleanQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) return null;
  const out = [];
  for (const q of raw) {
    const text = str(q?.text, 300);
    const options = Array.isArray(q?.options) ? q.options.map((o) => str(o, 120)) : [];
    const answer = Number(q?.answer);
    if (!text || options.length < 2 || options.length > 4 || options.some((o) => !o)) return null;
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
    out.push({ text, options, answer, time: clampInt(q?.time, 5, 300, 0) });
  }
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Kahoot formula: correct answers earn 500–1000 points, faster = more.
function points(ms, limitMs) {
  return Math.round(1000 * (1 - Math.min(ms, limitMs) / limitMs / 2));
}

// Standard competition ranking (ties share a rank: 1, 1, 3).
function rankPlayers(g) {
  const list = [...g.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  list.forEach((p, i) => (p.rank = i > 0 && p.score === list[i - 1].score ? list[i - 1].rank : i + 1));
  g.ranked = list;
}

const top = (g, n) => g.ranked.slice(0, n).map((p) => ({ name: p.name, score: p.score, rank: p.rank }));
const currentQ = (g) => g.questions[g.index];
const limitMs = (g) => (currentQ(g).time || g.settings.time) * 1000;
const answeredCount = (g) => [...g.players.values()].filter((p) => p.answer).length;

// ---------- views (everything a client needs to render its current screen; also used on reconnect) ----------
function hostView(g) {
  const v = { phase: g.phase, pin: g.pin, joinUrl: g.joinUrl, qr: g.qr, index: g.index, total: g.questions.length, playerCount: g.players.size };
  if (g.phase === 'lobby') v.players = [...g.players.values()].reverse().map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
  if (g.phase === 'question' || g.phase === 'reveal') {
    const q = currentQ(g);
    v.question = { text: q.text, options: q.options, time: limitMs(g) / 1000, remaining: Math.max(0, g.endsAt - Date.now()) };
    v.answered = answeredCount(g);
  }
  if (g.phase === 'reveal') {
    v.correct = currentQ(g).answer;
    v.counts = currentQ(g).options.map((_, i) => [...g.players.values()].filter((p) => p.answer?.choice === i).length);
  }
  if (g.phase === 'leaderboard') v.top = top(g, 5);
  if (g.phase === 'final') v.results = g.ranked.map((p) => ({ rank: p.rank, name: p.name, score: p.score, correct: p.correctCount }));
  return v;
}

function playerView(g, p) {
  const v = { phase: g.phase, name: p.name, score: p.score, rank: p.rank, playerCount: g.players.size, index: g.index, total: g.questions.length };
  if (g.phase === 'question') {
    const q = currentQ(g);
    v.optionsCount = q.options.length;
    v.remaining = Math.max(0, g.endsAt - Date.now());
    v.time = limitMs(g) / 1000;
    v.answered = !!p.answer;
    v.choice = p.answer?.choice ?? null;
    if (g.settings.showOnPhone) Object.assign(v, { text: q.text, options: q.options });
  }
  if (g.phase === 'reveal') Object.assign(v, { correct: p.lastCorrect, points: p.lastPoints, answered: !!p.answer, choice: p.answer?.choice ?? null, correctChoice: currentQ(g).answer });
  if (g.phase === 'leaderboard') v.top = top(g, 5);
  if (g.phase === 'final') v.podium = top(g, 3);
  return v;
}

function pushHost(g) {
  io.to(hostRoom(g)).emit('state', hostView(g));
}

function pushAll(g) {
  pushHost(g);
  for (const p of g.players.values()) if (p.socketId) io.to(p.socketId).emit('state', playerView(g, p));
}

// Lobby joins and answer counts can arrive in bursts of 150 — batch host updates to ≤ 4/s.
function nudgeHost(g) {
  if (g.nudge) return;
  g.nudge = setTimeout(() => {
    g.nudge = null;
    if (games.has(g.pin)) pushHost(g);
  }, 250);
}

// ---------- game flow ----------
function setPhase(g, phase) {
  clearTimeout(g.timer);
  g.phase = phase;
  g.lastActive = Date.now();
}

function startQuestion(g, index) {
  setPhase(g, 'question');
  g.index = index;
  for (const p of g.players.values()) p.answer = null;
  g.startedAt = Date.now();
  g.endsAt = g.startedAt + limitMs(g);
  g.timer = setTimeout(() => endQuestion(g), limitMs(g) + LATENCY_GRACE_MS);
  pushAll(g);
}

function endQuestion(g) {
  if (g.phase !== 'question') return;
  setPhase(g, 'reveal');
  const q = currentQ(g);
  for (const p of g.players.values()) {
    p.lastCorrect = p.answer?.choice === q.answer;
    p.lastPoints = p.lastCorrect ? points(p.answer.ms, limitMs(g)) : 0;
    p.score += p.lastPoints;
    if (p.lastCorrect) p.correctCount++;
  }
  rankPlayers(g);
  pushAll(g);
  if (g.settings.autoAdvance) g.timer = setTimeout(() => advance(g), AUTO_REVEAL_MS);
}

function showFinal(g) {
  setPhase(g, 'final');
  rankPlayers(g);
  pushAll(g);
}

// The host's single "Next" button: lobby → Q1 → reveal → leaderboard → Q2 … → final.
function advance(g) {
  if (g.phase === 'lobby') startQuestion(g, 0);
  else if (g.phase === 'question') endQuestion(g);
  else if (g.phase === 'reveal') {
    if (g.index === g.questions.length - 1) return showFinal(g);
    setPhase(g, 'leaderboard');
    pushAll(g);
    if (g.settings.autoAdvance) g.timer = setTimeout(() => advance(g), AUTO_BOARD_MS);
  } else if (g.phase === 'leaderboard') startQuestion(g, g.index + 1);
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  const reply = (cb, data) => typeof cb === 'function' && cb(data);

  socket.on('host:create', async ({ questions, settings, origin } = {}, cb) => {
    const qs = cleanQuestions(questions);
    if (!qs) return reply(cb, { error: 'Invalid quiz data.' });
    let base;
    try {
      base = new URL(origin);
      if (!/^https?:$/.test(base.protocol)) throw 0;
    } catch {
      return reply(cb, { error: 'Invalid origin.' });
    }
    const s = settings || {};
    const pin = newPin();
    const joinUrl = `${base.origin}/play?pin=${pin}`;
    const g = {
      pin,
      token: id(),
      joinUrl,
      qr: await QRCode.toDataURL(joinUrl, { margin: 1, width: 560, color: { dark: '#0b0b12', light: '#ffffff' } }),
      questions: s.shuffle ? shuffle(qs) : qs,
      settings: { time: clampInt(s.time, 5, 300, 20), showOnPhone: !!s.showOnPhone, autoAdvance: !!s.autoAdvance },
      players: new Map(),
      ranked: [],
      phase: 'lobby',
      index: -1,
      lastActive: Date.now(),
    };
    games.set(pin, g);
    socket.join(hostRoom(g));
    reply(cb, { pin, token: g.token });
    pushHost(g);
  });

  socket.on('host:rejoin', ({ pin, token } = {}, cb) => {
    const g = games.get(String(pin));
    if (!g || g.token !== token) return reply(cb, { error: 'Game not found.' });
    socket.join(hostRoom(g));
    reply(cb, { ok: true });
    pushHost(g);
  });

  socket.on('host:action', ({ pin, token, action, playerId } = {}, cb) => {
    const g = games.get(String(pin));
    if (!g || g.token !== token) return reply(cb, { error: 'Not authorised.' });
    g.lastActive = Date.now();
    if (action === 'next') {
      if (g.phase === 'lobby' && g.players.size === 0) return reply(cb, { error: 'Wait for at least one player.' });
      advance(g);
    } else if (action === 'end') {
      if (g.phase !== 'final') showFinal(g);
    } else if (action === 'kick') {
      const p = g.players.get(playerId);
      if (p) {
        g.players.delete(p.id);
        if (p.socketId) io.to(p.socketId).emit('kicked');
        rankPlayers(g);
        nudgeHost(g);
      }
    }
    reply(cb, { ok: true });
  });

  socket.on('player:join', ({ pin, name, playerId } = {}, cb) => {
    const g = games.get(String(pin));
    if (!g) return reply(cb, { error: 'No game with that PIN.' });

    let p = playerId && g.players.get(playerId);
    if (!p) {
      if (g.phase === 'final') return reply(cb, { error: 'This quiz has already ended.' });
      if (g.players.size >= MAX_PLAYERS) return reply(cb, { error: 'Game is full.' });
      const nick = str(name, 20);
      if (!nick) return reply(cb, { error: 'Enter a nickname.' });
      const lower = nick.toLowerCase();
      if ([...g.players.values()].some((x) => x.name.toLowerCase() === lower)) return reply(cb, { error: 'That nickname is taken.' });
      p = { id: id(), name: nick, score: 0, correctCount: 0, rank: 0, answer: null, joinedAt: Date.now() };
      g.players.set(p.id, p);
      rankPlayers(g);
    }
    p.socketId = socket.id;
    p.connected = true;
    socket.data = { pin: g.pin, playerId: p.id };
    reply(cb, { playerId: p.id, pin: g.pin });
    socket.emit('state', playerView(g, p));
    nudgeHost(g);
  });

  socket.on('player:answer', ({ choice } = {}, cb) => {
    const g = games.get(socket.data?.pin);
    const p = g?.players.get(socket.data.playerId);
    if (!p || g.phase !== 'question') return reply(cb, { error: 'Question is closed.' });
    if (p.answer) return reply(cb, { error: 'Already answered.' });
    const now = Date.now();
    if (!Number.isInteger(choice) || choice < 0 || choice >= currentQ(g).options.length || now > g.endsAt + LATENCY_GRACE_MS) {
      return reply(cb, { error: 'Answer not accepted.' });
    }
    p.answer = { choice, ms: now - g.startedAt };
    reply(cb, { ok: true });
    const connected = [...g.players.values()].filter((x) => x.connected);
    if (connected.every((x) => x.answer)) endQuestion(g);
    else nudgeHost(g);
  });

  socket.on('disconnect', () => {
    const g = games.get(socket.data?.pin);
    const p = g?.players.get(socket.data.playerId);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    if (g.phase === 'lobby') nudgeHost(g);
  });
});

// Drop abandoned games so memory doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - GAME_TTL_MS;
  for (const [pin, g] of games) {
    if (g.lastActive < cutoff) {
      clearTimeout(g.timer);
      games.delete(pin);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`ACM PDEU QUIZ running on http://localhost:${PORT}`));

