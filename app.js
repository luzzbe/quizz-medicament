// Quiz médicaments — session mixte orientée révision IDE.

const $ = (id) => document.getElementById(id);

const state = {
  data: [],
  session: null,
};

const QUESTION_MIX = [
  { type: 'dc-to-classe', weight: 35 },
  { type: 'dc-to-dci', weight: 30 },
  { type: 'classe-to-dc', weight: 20 },
  { type: 'dci-to-dc', weight: 15 },
];

const DIFFICULTY_LEVELS = {
  easy: {
    label: 'Facile',
    size: 100,
    description: 'les 100 médicaments les plus fréquents',
  },
  medium: {
    label: 'Intermédiaire',
    size: 200,
    description: 'les 200 premiers médicaments',
  },
  hard: {
    label: 'Difficile',
    size: Infinity,
    description: 'tout le dataset du quiz',
  },
};

// ---------- helpers ----------

function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHTML(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pickRandom(arr, n, exclude = new Set()) {
  const candidates = [...new Set(arr)].filter((x) => !exclude.has(normalize(x)));
  const picked = [];
  while (picked.length < n && candidates.length > 0) {
    const i = Math.floor(Math.random() * candidates.length);
    picked.push(candidates.splice(i, 1)[0]);
  }
  return picked;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dciLabel(item) {
  return item.dcis.join(' + ');
}

function medSummary(item) {
  return {
    dc: item.dc,
    dci: dciLabel(item),
    classe: item.classe || 'Classe non renseignée',
  };
}

function signature(item) {
  return normalize(item.dcis?.join('|') || item.dc || item.classe);
}

function isTrivialDcDciMatch(med) {
  const dc = normalize(med.dc);
  if (!dc || !med.dcis?.length) return false;
  return med.dcis.some((dci) => {
    const normalizedDci = normalize(dci);
    return normalizedDci && (dc === normalizedDci || dc.includes(normalizedDci) || normalizedDci.includes(dc));
  });
}

function interestingDcs(meds) {
  const dcs = meds.filter((m) => !isTrivialDcDciMatch(m)).map((m) => m.dc);
  return dcs.length > 0 ? dcs : meds.map((m) => m.dc);
}

function buildDciToDcPool(data) {
  const groups = new Map();
  for (const m of data) {
    if (m.dcis.length !== 1) continue;
    const sig = [...m.dcis].sort().join('|');
    let group = groups.get(sig);
    if (!group) {
      group = { dcis: [...m.dcis].sort(), _meds: [] };
      groups.set(sig, group);
    }
    group._meds.push(m);
  }

  return [...groups.values()]
    .map((group) => {
      const dcs = interestingDcs(group._meds).filter((dc, index, arr) => arr.indexOf(dc) === index);
      const ref = group._meds.find((m) => dcs.includes(m.dc)) || group._meds[0];
      return {
        dc: dcs[0] || ref.dc,
        dcis: group.dcis,
        classe: ref.classe,
        _acceptedDcs: dcs,
      };
    })
    .filter((group) => group._acceptedDcs.length > 0);
}

// ---------- questions ----------

const QUESTION_TYPES = {
  'dc-to-classe': {
    label: 'Classe',
    pool: (data) => data.filter((m) => m.classe),
    prompt: (item) => `Quelle est la <b>classe pharmacologique</b> de <b>${escapeHTML(item.dc)}</b> ?`,
    correct: (item) => item.classe,
    accepted: (item) => [item.classe],
    distractors: (data) => [...new Set(data.map((m) => m.classe).filter(Boolean))],
  },
  'dc-to-dci': {
    label: 'DCI',
    pool: (data) => data.filter((m) => m.dcis.length === 1 && !isTrivialDcDciMatch(m)),
    prompt: (item) => `Quelle est la <b>DCI</b> de <b>${escapeHTML(item.dc)}</b> ?`,
    correct: dciLabel,
    accepted: (item) => [dciLabel(item), item.dcis.join(' '), item.dcis.join(', '), ...item.dcis],
    distractors: (data) => {
      const set = new Set();
      for (const m of data) for (const d of m.dcis) set.add(d);
      return [...set];
    },
  },
  'classe-to-dc': {
    label: 'Exemple',
    pool: (data) => data.filter((m) => m.classe),
    prompt: (item) => `Lequel est un exemple de <b>${escapeHTML(item.classe)}</b> ?`,
    correct: (item) => item.dc,
    accepted: (item) => [item.dc],
    distractors: (data, item) => data.filter((m) => m.classe !== item.classe).map((m) => m.dc),
  },
  'dci-to-dc': {
    label: 'Nom commercial',
    pool: buildDciToDcPool,
    prompt: (item) => `Quel <b>nom commercial</b> correspond à <b>${escapeHTML(dciLabel(item))}</b> ?`,
    correct: (item) => item._acceptedDcs[0],
    accepted: (item) => item._acceptedDcs,
    distractors: (data, item) => data.filter((m) => !item._acceptedDcs.includes(m.dc)).map((m) => m.dc),
  },
};

function buildQuestionPools(data) {
  const pools = {};
  for (const { type } of QUESTION_MIX) {
    pools[type] = shuffle(QUESTION_TYPES[type].pool(data));
  }
  return pools;
}

function nextQuestionType(counts, target) {
  const totalWeight = QUESTION_MIX.reduce((sum, item) => sum + item.weight, 0);
  return QUESTION_MIX
    .map((item) => ({
      type: item.type,
      deficit: (target * item.weight) / totalWeight - (counts[item.type] || 0),
    }))
    .sort((a, b) => b.deficit - a.deficit)[0].type;
}

function takeFromPool(pool, usedSignatures) {
  const fallback = pool[0];
  const index = pool.findIndex((item) => !usedSignatures.has(signature(item)));
  if (index >= 0) return pool.splice(index, 1)[0];
  return fallback ? pool.shift() : null;
}

function datasetForDifficulty(level) {
  const config = DIFFICULTY_LEVELS[level] || DIFFICULTY_LEVELS.medium;
  return state.data.slice(0, config.size);
}

function buildMixedQueue(data, count) {
  const requested = count > 0 ? count : data.length;
  const pools = buildQuestionPools(data);
  const counts = Object.fromEntries(QUESTION_MIX.map(({ type }) => [type, 0]));
  const usedSignatures = new Set();
  const queue = [];

  while (queue.length < requested) {
    const types = [
      nextQuestionType(counts, requested),
      ...shuffle(QUESTION_MIX.map(({ type }) => type)),
    ];
    const type = types.find((candidate) => pools[candidate]?.length > 0);
    if (!type) break;

    const item = takeFromPool(pools[type], usedSignatures);
    if (!item) break;

    usedSignatures.add(signature(item));
    counts[type]++;
    queue.push({ type, item, config: QUESTION_TYPES[type] });
  }

  return queue;
}

// ---------- session lifecycle ----------

function startSession(count, difficulty) {
  const quizData = datasetForDifficulty(difficulty);
  const queue = buildMixedQueue(quizData, count);
  state.session = {
    count,
    difficulty,
    data: quizData,
    queue,
    index: 0,
    score: 0,
    wrong: [],
  };
  $('setup').hidden = true;
  $('results').hidden = true;
  $('quiz').hidden = false;
  renderQuestion();
}

function currentQuestion() {
  return state.session.queue[state.session.index];
}

function renderQuestion() {
  const s = state.session;
  if (s.index >= s.queue.length) return endSession();
  const question = currentQuestion();
  const progressPct = Math.round((s.index / s.queue.length) * 100);
  $('progress-text').textContent = `Question ${s.index + 1} / ${s.queue.length} · ${question.config.label}`;
  $('score-text').textContent = `Score : ${s.score}`;
  $('progress-bar').style.width = `${progressPct}%`;
  $('prompt').innerHTML = question.config.prompt(question.item);
  $('feedback').hidden = true;
  $('feedback').className = '';
  $('next').hidden = true;
  $('answers').innerHTML = '';
  renderQCM(question);
}

function renderQCM(question) {
  const correctList = question.config.accepted(question.item);
  const correctDisplay = question.config.correct(question.item);
  const correctNorm = new Set(correctList.map(normalize));
  const distractorPool = question.config.distractors(state.session.data, question.item);
  const distractors = pickRandom(distractorPool, 3, correctNorm);
  const options = shuffle([correctDisplay, ...distractors]);

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'answer-btn';
    btn.textContent = opt;
    btn.addEventListener('click', () => answerQCM(opt, question));
    $('answers').appendChild(btn);
  }
}

function answerQCM(picked, question) {
  const acceptedNorm = new Set(question.config.accepted(question.item).map(normalize));
  const correctDisplay = question.config.correct(question.item);
  const isCorrect = acceptedNorm.has(normalize(picked));

  for (const btn of $('answers').querySelectorAll('.answer-btn')) {
    btn.disabled = true;
    if (normalize(btn.textContent) === normalize(correctDisplay)) btn.classList.add('correct');
    else if (btn.textContent === picked) btn.classList.add('wrong');
  }
  finishQuestion(isCorrect, question, picked, correctDisplay);
}

function renderFeedbackDetails(item) {
  const summary = medSummary(item);
  return `
    <dl class="feedback-details">
      <div><dt>DC</dt><dd>${escapeHTML(summary.dc)}</dd></div>
      <div><dt>DCI</dt><dd>${escapeHTML(summary.dci)}</dd></div>
      <div><dt>Classe</dt><dd>${escapeHTML(summary.classe)}</dd></div>
    </dl>
  `;
}

function finishQuestion(isCorrect, question, picked, correctDisplay) {
  const s = state.session;
  if (isCorrect) s.score++;
  else {
    s.wrong.push({
      question,
      picked,
      correct: correctDisplay,
      prompt: question.config.prompt(question.item),
    });
  }

  const progressPct = Math.round(((s.index + 1) / s.queue.length) * 100);
  const f = $('feedback');
  f.hidden = false;
  f.className = isCorrect ? 'ok' : 'ko';
  f.innerHTML = `
    <p>${isCorrect
      ? `<b>Correct</b> — ${escapeHTML(correctDisplay)}`
      : `<b>Faux</b> — la bonne réponse est <b>${escapeHTML(correctDisplay)}</b>`}</p>
    ${renderFeedbackDetails(question.item)}
  `;
  $('score-text').textContent = `Score : ${s.score}`;
  $('progress-bar').style.width = `${progressPct}%`;
  $('next').hidden = false;
  $('next').focus();
}

function endSession() {
  const s = state.session;
  $('quiz').hidden = true;
  $('results').hidden = false;
  const total = s.queue.length;
  const pct = total === 0 ? 0 : Math.round((s.score / total) * 100);
  const label = pct >= 90 ? 'Excellent' : pct >= 70 ? 'Solide' : pct >= 50 ? 'En progression' : 'À consolider';
  $('result-summary').textContent = `${label} : ${s.score} / ${total} (${pct} %)`;
  const list = $('wrong-list');
  list.innerHTML = '';
  if (s.wrong.length === 0) {
    list.innerHTML = '<li>Aucune erreur — bravo !</li>';
  } else {
    for (const w of s.wrong) {
      const li = document.createElement('li');
      const q = document.createElement('span');
      q.className = 'q';
      q.innerHTML = w.prompt;
      const a = document.createElement('span');
      a.className = 'a';
      const summary = medSummary(w.question.item);
      a.textContent = `Réponse : ${w.correct}` +
        (w.picked ? ` — vous avez répondu : ${w.picked}` : '') +
        ` · ${summary.dc} / ${summary.dci} / ${summary.classe}`;
      li.append(q, a);
      list.appendChild(li);
    }
  }
}

// ---------- bootstrap ----------

async function loadData() {
  const res = await fetch('./data/medicaments.json');
  if (!res.ok) throw new Error(`Échec chargement data : ${res.status}`);
  state.data = await res.json();
}

function describeDataset() {
  const total = state.data.length;
  const dcToDci = QUESTION_TYPES['dc-to-dci'].pool(state.data).length;
  const dciToDc = QUESTION_TYPES['dci-to-dc'].pool(state.data).length;
  $('setup-meta').textContent =
    `${total} médicaments au total, découpés en niveaux progressifs.`;
}

function getSetupValues() {
  const difficulty = document.querySelector('input[name=difficulty]:checked').value;
  const count = Number(document.querySelector('input[name=count]:checked').value);
  return { count, difficulty };
}

function bind() {
  $('start').addEventListener('click', () => {
    const { count, difficulty } = getSetupValues();
    startSession(count, difficulty);
  });
  $('next').addEventListener('click', () => {
    state.session.index++;
    renderQuestion();
  });
  $('abort').addEventListener('click', () => {
    state.session = null;
    $('quiz').hidden = true;
    $('setup').hidden = false;
  });
  $('restart').addEventListener('click', () => {
    const s = state.session;
    if (s) startSession(s.count, s.difficulty);
  });
  $('new-session').addEventListener('click', () => {
    $('results').hidden = true;
    $('setup').hidden = false;
  });
}

(async function init() {
  bind();
  try {
    await loadData();
    describeDataset();
    $('loading').hidden = true;
    $('setup').hidden = false;
  } catch (e) {
    $('loading').textContent = `Erreur : ${e.message}`;
  }
})();
