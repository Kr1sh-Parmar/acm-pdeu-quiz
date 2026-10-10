const SESSION_KEY = 'acmquiz:player';
const urlPin = new URLSearchParams(location.search).get('pin');
let session = store.get(SESSION_KEY); // { pin, playerId, name }
let joined = false;

if (urlPin) {
  $('#pin').value = urlPin;
  $('#pin').classList.add('hidden');
}
if (session?.name) $('#name').value = session.name;

const main = $('#main');
const joinHtml = main.innerHTML;

// ---------- join / rejoin ----------
socket.on('connect', async () => {
  $('#me').classList.remove('pulse');
  if (!session || (urlPin && session.pin !== urlPin)) return;
  const res = await emit('player:join', { pin: session.pin, playerId: session.playerId });
  if (res.error) {
    store.del(SESSION_KEY);
    session = null;
    showJoin(res.error);
  } else joined = true;
});

socket.on('disconnect', () => {
  if (joined) $('#me').classList.add('pulse');
});

main.addEventListener('submit', async (e) => {
  if (e.target.id !== 'joinForm') return;
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  const name = $('#name').value;
  const res = await emit('player:join', { pin: $('#pin').value.trim(), name });
  btn.disabled = false;
  if (res.error) return ($('#joinError').textContent = res.error);
  session = { pin: res.pin, playerId: res.playerId, name: name.trim() };
  store.set(SESSION_KEY, session);
  joined = true;
});

function showJoin(error) {
  joined = false;
  main.innerHTML = joinHtml;
  if (urlPin) {
    $('#pin').value = urlPin;
    $('#pin').classList.add('hidden');
  }
  $('#joinError').textContent = error || '';
  $('#me').textContent = '';
  $('#score').classList.add('hidden');
}

socket.on('kicked', () => {
  store.del(SESSION_KEY);
  session = null;
  showJoin('You were removed from the game by the host.');
});

// ---------- rendering ----------
const msg = (inner) => (main.innerHTML = `<div class="msg">${inner}</div>`);

socket.on('state', (v) => {
  $('#me').textContent = v.name;
  $('#score').textContent = v.score;
  $('#score').classList.remove('hidden');
  ({ lobby, question, reveal, leaderboard, final })[v.phase](v);
});

function lobby() {
  msg(`<div class="big">✓</div><h1>You're in!</h1><p class="muted">See your nickname on the big screen?<br>The quiz will start soon.</p>`);
}

function question(v) {
  if (v.answered) return locked(v.choice);
  if (v.remaining <= 0) return msg(`<h1>Time's up</h1>`);
  const two = v.optionsCount === 2;
  main.innerHTML = `
    <div class="ptimer"><div id="tbar"></div></div>
    <div class="muted" style="text-align:center">Question ${v.index + 1} of ${v.total}</div>
    ${v.text ? `<div class="ptext">${esc(v.text)}</div>` : ''}
    <div class="pgrid ${two ? 'two' : ''}">${Array.from({ length: v.optionsCount }, (_, i) =>
      `<button class="pbtn c${i}" data-choice="${i}" aria-label="${COLOR_NAMES[i]}${v.options ? ': ' + esc(v.options[i]) : ''}">${SHAPES[i]}${v.options ? `<small>${esc(v.options[i])}</small>` : ''}</button>`
    ).join('')}</div>`;
  const bar = $('#tbar');
  bar.style.width = (v.remaining / (v.time * 1000)) * 100 + '%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${v.remaining}ms linear`;
    bar.style.width = '0%';
  }));
}

main.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pbtn');
  if (!btn) return;
  const choice = Number(btn.dataset.choice);
  main.querySelectorAll('.pbtn').forEach((b) => (b.disabled = true));
  navigator.vibrate?.(30);
  const res = await emit('player:answer', { choice });
  if (res.error) msg(`<h1>${esc(res.error)}</h1>`);
  else locked(choice);
});

function locked(choice) {
  msg(`<div class="pbtn c${choice}" style="width:120px;height:120px;justify-self:center">${SHAPES[choice]}</div>
       <h1>Answer locked in</h1><p class="muted pulse">Waiting for the others…</p>`);
}

function reveal(v) {
  const cls = v.correct ? 'good' : v.answered ? 'bad' : 'none';
  const title = v.correct ? 'Correct!' : v.answered ? 'Wrong' : 'No answer';
  main.innerHTML = `
    <div class="result ${cls}">
      <div class="big" style="font-size:4rem">${v.correct ? '✓' : '✗'}</div>
      <h1>${title}</h1>
      <div class="pts">+${v.points}</div>
      ${v.correct ? '' : `<p>Correct answer: <span class="c${v.correctChoice}" style="display:inline-flex;padding:.3rem;border-radius:6px;vertical-align:middle">${SHAPES[v.correctChoice]}</span> ${COLOR_NAMES[v.correctChoice]}</p>`}
      <p>You're in <b>${ordinal(v.rank)}</b> place of ${v.playerCount}</p>
    </div>`;
}

function leaderboard(v) {
  main.innerHTML = `
    <div class="msg" style="flex:none;padding:1rem 0"><p class="muted">Your rank</p><div class="big">${ordinal(v.rank)}</div><p class="muted">${v.score} points</p></div>
    <div class="mini-board">${v.top
      .map((p) => `<div class="board-row ${p.name === v.name ? 'me' : ''}"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)}</span><span>${p.score}</span></div>`)
      .join('')}</div>`;
}

function final(v) {
  const medal = ['🥇', '🥈', '🥉'][v.rank - 1] || '🎉';
  msg(`<div class="big">${medal}</div><h1>You finished ${ordinal(v.rank)}</h1>
       <p class="muted">${v.score} points · ${v.playerCount} players</p>
       <div class="mini-board" style="margin-top:1rem;text-align:left">${v.podium
         .map((p) => `<div class="board-row ${p.name === v.name ? 'me' : ''}"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)}</span><span>${p.score}</span></div>`)
         .join('')}</div>`);
  store.del(SESSION_KEY);
}
