// Load test / end-to-end self-check.
//   node scripts/load-test.js [url] [players] [pin]
// With a pin: bots join your real game and answer randomly — you drive it from the host screen.
// Without a pin: the script also hosts a 3-question game, plays it through, and asserts the results.
const { io } = require('socket.io-client');
const assert = require('assert');

const URL_ = process.argv[2] || 'http://localhost:3000';
const N = Number(process.argv[3] || 150);
const PIN = process.argv[4];

const connect = () => io(URL_, { transports: ['websocket'], forceNew: true });
const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bots(pin) {
  const players = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const s = connect();
      const me = { s, name: `bot${i + 1}`, states: [] };
      s.on('state', (v) => {
        me.states.push(v);
        if (v.phase === 'question' && !v.answered) {
          setTimeout(() => call(s, 'player:answer', { choice: Math.floor(Math.random() * v.optionsCount) }), Math.random() * 3000);
        }
      });
      const res = await call(s, 'player:join', { pin, name: me.name });
      assert(!res.error, `${me.name}: ${res.error}`);
      return me;
    })
  );
  console.log(`${N} players joined game ${pin}`);
  return players;
}

async function selfHosted() {
  const host = connect();
  let view;
  host.on('state', (v) => (view = v));
  const questions = [
    { text: 'Q1', options: ['a', 'b', 'c', 'd'], answer: 0, time: 5 },
    { text: 'Q2', options: ['True', 'False'], answer: 1, time: 5 },
    { text: 'Q3', options: ['a', 'b', 'c'], answer: 2, time: 5 },
  ];
  const created = await call(host, 'host:create', { questions, origin: URL_, settings: { time: 20 } });
  assert(created.pin, created.error);
  const auth = { pin: created.pin, token: created.token };

  const players = await bots(created.pin);
  for (let t = 0; t < 50 && view.playerCount !== N; t++) await sleep(100);
  assert.equal(view.playerCount, N, 'host lobby count');
  console.log(`host lobby shows ${view.playerCount} players`);

  // Duplicate nicknames are rejected, case-insensitively.
  const dup = connect();
  assert.equal((await call(dup, 'player:join', { pin: created.pin, name: 'BOT1' })).error, 'That nickname is taken.');
  dup.close();

  for (let q = 0; q < questions.length; q++) {
    const t0 = Date.now();
    await call(host, 'host:action', { ...auth, action: 'next' }); // lobby/leaderboard → question
    while (view.phase !== 'reveal') await sleep(50);
    const counts = view.counts.reduce((a, b) => a + b, 0);
    console.log(`Q${q + 1}: all ${counts}/${N} answered, revealed after ${Date.now() - t0}ms, counts=${view.counts}`);
    assert.equal(counts, N, 'every bot answered');
    const tr = Date.now();
    while (players.some((p) => p.states.at(-1).phase !== 'reveal') && Date.now() - tr < 10000) await sleep(20);
    console.log(`    all phones got their result ${Date.now() - tr}ms after the host`);
    for (const p of players) {
      const r = p.states.at(-1);
      assert.equal(r.phase, 'reveal');
      if (r.correct) assert(r.points >= 500 && r.points <= 1000, `points in range: ${r.points}`);
      else assert.equal(r.points, 0);
    }
    await call(host, 'host:action', { ...auth, action: 'next' }); // reveal → leaderboard / final
    await sleep(300);
  }

  assert.equal(view.phase, 'final');
  assert.equal(view.results.length, N);
  const sorted = view.results.every((r, i, a) => i === 0 || a[i - 1].score >= r.score);
  assert(sorted, 'results sorted by score');
  const hostTotal = view.results.find((r) => r.name === 'bot1').score;
  assert.equal(players[0].states.at(-1).score, hostTotal, 'player score matches host');
  console.log('Top 3:', view.results.slice(0, 3).map((r) => `${r.name} ${r.score}`).join(', '));
  console.log('PASS');
  [host, ...players.map((p) => p.s)].forEach((s) => s.close());
}

(PIN ? bots(PIN) : selfHosted()).catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
