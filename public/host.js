const SESSION_KEY = 'acmquiz:host';
let session = store.get(SESSION_KEY); // { pin, token }
let questions = null;
let lastKey = null;
let timerLoop = null;
let finalResults = [];

// ---------- CSV upload ----------
const drop = $('#drop');
['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => ev.dataTransfer.files[0] && loadFile(ev.dataTransfer.files[0]));
$('#file').addEventListener('change', (ev) => ev.target.files[0] && loadFile(ev.target.files[0]));

function loadFile(file) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase().replace(/[\s_]+/g, ''),
    complete: (res) => showPreview(file.name, parseRows(res.data, res.meta.fields || [])),
  });
}

// Turns CSV rows into { text, options, answer (0-based), time } and collects per-row errors.
function parseRows(rows, fields) {
  const missing = ['question', 'option1', 'option2', 'answer'].filter((f) => !fields.includes(f));
  if (missing.length) return { fatal: `Missing column(s): ${missing.join(', ')}` };
  return {
    rows: rows.map((r) => {
      const errors = [];
      const text = (r.question || '').trim();
      const raw = [r.option1, r.option2, r.option3, r.option4].map((o) => (o || '').trim());
      const lastFilled = raw.findLastIndex(Boolean);
      const options = raw.slice(0, lastFilled + 1);
      if (!text) errors.push('question is empty');
      if (options.length < 2) errors.push('needs at least 2 options');
      if (options.some((o) => !o)) errors.push('options must be filled in order (no gaps)');

      const a = (r.answer || '').trim();
      let answer = -1;
      if (/^[1-4]$/.test(a)) answer = Number(a) - 1;
      else if (/^[a-d]$/i.test(a)) answer = a.toUpperCase().charCodeAt(0) - 65;
      else answer = options.findIndex((o) => o.toLowerCase() === a.toLowerCase());
      if (answer < 0 || answer >= options.length) errors.push(`answer "${a}" doesn't match an option`);

      const t = (r.time || '').trim();
      const time = t ? Number(t) : 0;
      if (t && !(Number.isInteger(time) && time >= 5 && time <= 300)) errors.push('time must be 5–300 seconds');
      return { text, options, answer, time, errors };
    }),
  };
}

function showPreview(name, parsed) {
  const preview = $('#preview');
  questions = null;
  $('#create').disabled = true;
  $('#setupError').textContent = '';
  $('#summary').textContent = '';
  preview.classList.add('hidden');
  if (parsed.fatal) return ($('#setupError').textContent = parsed.fatal);
  const { rows } = parsed;
  if (!rows.length) return ($('#setupError').textContent = 'No questions found in the file.');
  if (rows.length > 200) return ($('#setupError').textContent = 'Max 200 questions per quiz.');

  const bad = rows.filter((r) => r.errors.length).length;
  $('#summary').textContent = `${name} · ${rows.length} question${rows.length > 1 ? 's' : ''}`;
  if (bad) $('#setupError').textContent = `${bad} row(s) have problems — fix them in the CSV and drop it again.`;
  preview.innerHTML = `<table><thead><tr><th>#</th><th>Question</th><th>Options</th><th>Time</th><th></th></tr></thead><tbody>${rows
    .map((r, i) => `<tr class="${r.errors.length ? 'bad' : ''}">
      <td>${i + 1}</td>
      <td>${esc(r.text)}</td>
      <td>${r.options.map((o, j) => (j === r.answer ? `<span class="ok">${esc(o)} ✓</span>` : esc(o))).join('<br>')}</td>
      <td>${r.time ? r.time + 's' : '<span class="muted">default</span>'}</td>
      <td>${r.errors.length ? `<span class="error">${esc(r.errors.join('; '))}</span>` : '<span class="ok">✓</span>'}</td>
    </tr>`)
    .join('')}</tbody></table>`;
  preview.classList.remove('hidden');
  if (!bad) {
    questions = rows.map(({ text, options, answer, time }) => ({ text, options, answer, time }));
    $('#create').disabled = false;
  }
}

$('#create').addEventListener('click', async () => {
  if (!questions) return;
  $('#create').disabled = true;
  const res = await emit('host:create', {
    questions,
    origin: location.origin,
    settings: {
      time: Number($('#time').value),
      shuffle: $('#shuffle').checked,
      showOnPhone: $('#showOnPhone').checked,
      autoAdvance: $('#autoAdvance').checked,
    },
  });
  $('#create').disabled = false;
  if (res.error) return ($('#setupError').textContent = res.error);
  session = { pin: res.pin, token: res.token };
  store.set(SESSION_KEY, session);
});

// ---------- connection / reconnect ----------
socket.on('connect', async () => {
  if (!session) return;
  const res = await emit('host:rejoin', session);
  if (res.error) resetToSetup();
});

function resetToSetup() {
  session = null;
  store.del(SESSION_KEY);
  lastKey = null;
  clearInterval(timerLoop);
  $('#view').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#bar').innerHTML = '';
}

const action = (name, extra) => emit('host:action', { ...session, action: name, ...extra });

// ---------- rendering ----------
socket.on('state', (v) => {
  $('#setup').classList.add('hidden');
  $('#view').classList.remove('hidden');
  const key = `${v.phase}:${v.index}`;
  const same = key === lastKey;
  lastKey = key;
  ({ lobby: renderLobby, question: renderQuestion, reveal: renderReveal, leaderboard: renderBoard, final: renderFinal })[v.phase](v, same);
});

function setBar(html) {
  $('#bar').innerHTML = html;
}

const nextBtn = (label) => `<button class="btn primary" id="next">${label}</button>`;
const endBtn = `<button class="btn ghost" id="end">End quiz</button>`;

document.addEventListener('click', async (e) => {
  if (e.target.id === 'next') {
    const res = await action('next');
    if (res.error) alert(res.error);
  }
  if (e.target.id === 'end' && confirm('End the quiz now and show final results?')) action('end');
  if (e.target.id === 'newQuiz' && confirm('Start a new quiz? This game will be closed on this screen.')) resetToSetup();
  if (e.target.id === 'download') downloadResults();
  const chip = e.target.closest('.chip');
  if (chip && confirm(`Remove "${chip.textContent}" from the game?`)) action('kick', { playerId: chip.dataset.id });
});

// Presenter clickers send →/PageDown; space works too.
document.addEventListener('keydown', (e) => {
  if (['ArrowRight', 'PageDown', ' '].includes(e.key) && $('#next') && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    $('#next').click();
  }
});

function renderLobby(v, same) {
  setBar(`<span class="pill"><b>${v.playerCount}</b> joined</span>${nextBtn('Start quiz →')}`);
  $('#next').disabled = v.playerCount === 0;
  const chips = v.players.map((p) => `<span class="chip ${p.connected ? '' : 'off'}" data-id="${p.id}" title="Click to remove">${esc(p.name)}</span>`).join('');
  if (same) {
    $('#count').textContent = v.playerCount;
    $('#chips').innerHTML = chips;
    return;
  }
  const url = new URL(v.joinUrl);
  $('#view').innerHTML = `
    <div class="lobby">
      <div class="card join-card">
        <img src="${v.qr}" alt="QR code to join">
        <div class="url">Join at <b style="color:var(--text)">${esc(url.host)}/play</b></div>
        <div class="muted">Game PIN</div>
        <div class="pin">${v.pin}</div>
      </div>
      <div>
        <div class="players-head">
          <div><div class="count" id="count">${v.playerCount}</div><div class="muted">players</div></div>
          <div class="muted pulse">Waiting for players…</div>
        </div>
        <div class="chips" id="chips">${chips}</div>
      </div>
    </div>`;
}

function questionLayout(v) {
  const q = v.question;
  return `
    <div class="qhead">
      <div class="timer"><svg viewBox="0 0 104 104"><circle class="track" cx="52" cy="52" r="46"/><circle class="bar" id="ring" cx="52" cy="52" r="46"/></svg><span id="secs"></span></div>
      <div class="qtext">${esc(q.text)}</div>
      <div class="answers-count"><b id="answered">${v.answered}</b><span class="muted">answers</span></div>
    </div>
    <div class="bars" id="bars"></div>
    <div class="tiles">${q.options
      .map((o, i) => `<div class="tile c${i}" id="tile${i}">${SHAPES[i]}<span class="label">${esc(o)}</span><span class="check"></span></div>`)
      .join('')}</div>`;
}

function renderQuestion(v, same) {
  setBar(`<span class="pill">Question <b>${v.index + 1}</b> / ${v.total}</span>${endBtn}${nextBtn('Skip ⏭')}`);
  if (same) return void ($('#answered').textContent = v.answered);
  $('#view').innerHTML = questionLayout(v);
  const total = v.question.time * 1000;
  const endAt = Date.now() + v.question.remaining;
  clearInterval(timerLoop);
  const tick = () => {
    const left = Math.max(0, endAt - Date.now());
    $('#secs').textContent = Math.ceil(left / 1000);
    $('#ring').style.strokeDashoffset = 289 * (1 - left / total);
    if (!left) clearInterval(timerLoop);
  };
  tick();
  timerLoop = setInterval(tick, 100);
}

function renderReveal(v) {
  clearInterval(timerLoop);
  const last = v.index === v.total - 1;
  setBar(`<span class="pill">Question <b>${v.index + 1}</b> / ${v.total}</span>${endBtn}${nextBtn(last ? 'Final results 🏆' : 'Leaderboard →')}`);
  if (!$('#bars')) $('#view').innerHTML = questionLayout(v); // e.g. host refreshed during reveal
  $('#secs').textContent = '0';
  $('#ring').style.strokeDashoffset = 289;
  $('#answered').textContent = v.answered;
  const max = Math.max(1, ...v.counts);
  $('#bars').innerHTML = v.counts
    .map((n, i) => `<div class="b ${i === v.correct ? '' : 'dim'}"><div class="n">${SHAPES[i]}${n}${i === v.correct ? ' ✓' : ''}</div><div class="fill c${i}" data-h="${(n / max) * 26}vh"></div></div>`)
    .join('');
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.bars .fill').forEach((f) => (f.style.height = f.dataset.h))));
  v.counts.forEach((_, i) => {
    const t = $(`#tile${i}`);
    t.classList.toggle('dim', i !== v.correct);
    t.classList.toggle('right', i === v.correct);
    t.querySelector('.check').textContent = i === v.correct ? '✓' : '';
  });
}

function renderBoard(v) {
  setBar(`<span class="pill">After question <b>${v.index + 1}</b> / ${v.total}</span>${endBtn}${nextBtn('Next question →')}`);
  $('#view').innerHTML = `<div class="board"><h2>Leaderboard</h2>${v.top
    .map((p, i) => `<div class="board-row" style="animation-delay:${i * 90}ms"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)}</span><span>${p.score}</span></div>`)
    .join('')}</div>`;
}

function renderFinal(v) {
  clearInterval(timerLoop);
  finalResults = v.results;
  setBar(`<span class="pill"><b>${v.results.length}</b> players</span>`);
  const [p1, p2, p3] = v.results;
  const col = (p, cls, n) =>
    p ? `<div class="col ${cls}"><div class="who">${esc(p.name)}</div><div class="pts">${p.score} pts</div><div class="block">${n}</div></div>` : `<div class="col ${cls}"></div>`;
  $('#view').innerHTML = `
    <h2 style="text-align:center;font-size:clamp(2rem,4vw,3rem)">Final results</h2>
    <div class="podium">${col(p2, 'p2', 2)}${col(p1, 'p1', 1)}${col(p3, 'p3', 3)}</div>
    <div class="final-actions">
      <button class="btn primary" id="download">Download results CSV</button>
      <button class="btn ghost" id="newQuiz">New quiz</button>
    </div>`;
}

function downloadResults() {
  // Prefix cells that Excel would treat as formulas (nicknames are user input).
  const cell = (x) => `"${String(x).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
  const csv = ['rank,name,score,correct', ...finalResults.map((r) => [r.rank, r.name, r.score, r.correct].map(cell).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `acm-pdeu-quiz-${session?.pin || 'results'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
