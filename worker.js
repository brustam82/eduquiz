// EduQuiz — API-шлюз.
// Браузер не ходит в базу за результатами и экзаменами — только сюда.
// Ключ базы, пароль учителя и токен бота живут в секретах Cloudflare.

const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// запрос в Supabase от имени service_role (RLS не применяется)
async function sb(env, path, init = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`SB ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

// отправка в конкретный чат
async function tg(env, chat, text) {
  if (!env.TG_BOT_TOKEN || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chat), text, parse_mode: 'HTML' })
    });
  } catch (e) { /* телеграм недоступен — результат всё равно сохранён */ }
}

// ── тексты для учителя — правьте здесь ──
const mmss = t => `${Math.floor((t || 0) / 60)}:${String((t || 0) % 60).padStart(2, '0')}`;

// ctx: { title, rank, of }  — может быть пустым
function fmtResult(r, c = {}) {
  const dot = r.percent >= 80 ? '🟢' : r.percent >= 50 ? '🟡' : '🔴';
  const L = [`${dot} <b>${esc(r.student)}</b> — ${r.correct}/${r.total} · baho ${r.grade_mark}`];

  if (c.title) L.push(`📝 ${esc(c.title)} · <code>${esc(r.exam_code)}</code>`);

  // подозрительно быстро = меньше 5 секунд на вопрос → скорее всего тыкал наугад
  let t = `⏱ ${mmss(r.duration_s)}`;
  if (r.duration_s && r.total && r.duration_s / r.total < 5) t += ' ⚡ juda tez — tekshiring';
  L.push(t);

  // номера вопросов, где ошибся
  if (Array.isArray(r.answers)) {
    const bad = r.answers.map((a, i) => (a && a.ok ? null : i + 1)).filter(Boolean);
    if (bad.length) L.push(`❌ Xato: ${bad.join(', ')}`);
  }

  if (c.rank) L.push(`🏅 O'rin: ${c.rank} / ${c.of}`);
  return L.join('\n');
}

function fmtSummary(ex, rows) {
  const avg = Math.round(rows.reduce((s, r) => s + (r.percent || 0), 0) / rows.length);
  const medal = ['🥇', '🥈', '🥉'];
  const top = rows.slice(0, 3)
    .map((r, i) => `${medal[i]} ${esc(r.student)} — ${r.correct}/${r.total} (${r.percent}%)`)
    .join('\n');
  let t = `📊 <b>${esc(ex.title)}</b> · <code>${esc(ex.code)}</code>\nKunlik hisobot\n\n`
    + `Qatnashdi: <b>${rows.length}</b> o'quvchi\n`
    + `O'rtacha natija: <b>${avg}%</b>\n\n`
    + `<b>Eng yaxshi 3 ta:</b>\n${top}`;
  if (ex.active_till) {
    const d = new Date(ex.active_till).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
    t += `\n\n⏳ Imtihon tugashi: ${d}`;
  }
  return t;
}

const genCode = () => Array.from(
  crypto.getRandomValues(new Uint8Array(5)),
  b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 30]
).join('');

// ══════════ безопасность ══════════
const ENC = new TextEncoder();
const b64  = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const hex  = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

async function hmac(keyRaw, msg) {
  const k = await crypto.subtle.importKey('raw', keyRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, ENC.encode(msg));
}

// сравнение без утечки времени
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── пропуск учителя: id.срок.подпись ──
const sessKey = env => ENC.encode('eduquiz-session:' + env.SUPABASE_SERVICE_KEY);

async function mkToken(env, id) {
  const body = `${id}.${Date.now() + 30 * 864e5}`;          // 30 дней
  return `${body}.${b64(await hmac(sessKey(env), body))}`;
}

async function readToken(env, t) {
  if (!t || typeof t !== 'string') return null;
  const i = t.lastIndexOf('.');
  if (i < 0) return null;
  const body = t.slice(0, i), sig = t.slice(i + 1);
  const [id, exp] = body.split('.');
  if (!id || !exp || +exp < Date.now()) return null;
  if (!same(sig, b64(await hmac(sessKey(env), body)))) return null;
  return +id;
}

// ── подпись Telegram: доказывает, что человек реально из бота ──
async function checkInitData(env, initData) {
  if (!initData || !env.TG_BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const got = p.get('hash');
  if (!got) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(ENC.encode('WebAppData'), env.TG_BOT_TOKEN);
  if (!same(hex(await hmac(new Uint8Array(secret), dcs)), got)) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 86400) return null;   // старше суток
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

// ── подпись кнопки Telegram на сайте (в браузере) ──
async function checkWidget(env, d) {
  if (!d || !d.hash || !env.TG_BOT_TOKEN) return null;
  const rest = { ...d };
  delete rest.hash;
  const dcs = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = await crypto.subtle.digest('SHA-256', ENC.encode(env.TG_BOT_TOKEN));
  if (!same(hex(await hmac(new Uint8Array(secret), dcs)), d.hash)) return null;
  if (Date.now() / 1000 - (+rest.auth_date || 0) > 86400) return null;
  return rest;
}

const auth = async (env, b) => readToken(env, b && b.token);

// ── результат ученика ──
async function postResult(req, env, ctx) {
  const b = await req.json();
  const total = Math.max(0, Math.min(200, +b.total || 0));
  const correct = Math.max(0, Math.min(total, +b.correct || 0));
  const percent = total ? Math.round(correct / total * 100) : 0;
  const row = {
    exam_code: b.exam_code ? String(b.exam_code).slice(0, 16) : null,
    student: String(b.student || '').trim().slice(0, 80) || '—',
    subject: String(b.subject || 'math').slice(0, 40),
    lang: 'uz',
    total,
    correct,
    percent,
    // та же шкала, что показывается ученику на экране результата
    grade_mark: percent >= 90 ? 5 : percent >= 70 ? 4 : percent >= 50 ? 3 : 2,
    duration_s: b.duration_s != null ? +b.duration_s : null,
    answers: b.answers ?? null
  };
  const saved = await sb(env, 'results', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });

  const id = saved?.[0]?.id ?? null;

  // куда слать и что показать: название экзамена, телеграм учителя, место в классе
  let chat = env.TG_CHAT_ID;
  const c = {};
  if (row.exam_code) {
    try {
      const ex = await sb(env,
        `exams?code=eq.${encodeURIComponent(row.exam_code)}&select=title,teacher_chat_id&limit=1`);
      if (ex && ex[0]) {
        c.title = ex[0].title;
        if (ex[0].teacher_chat_id) chat = ex[0].teacher_chat_id;
      }
      // место среди всех, кто прошёл этот экзамен: выше % → выше; при равенстве быстрее → выше
      const all = await sb(env,
        `results?exam_code=eq.${encodeURIComponent(row.exam_code)}`
        + '&select=id,percent,duration_s&limit=500');
      all.sort((a, b) => (b.percent - a.percent) || ((a.duration_s || 9e9) - (b.duration_s || 9e9)));
      const i = all.findIndex(x => x.id === id);
      if (i >= 0 && all.length > 1) { c.rank = i + 1; c.of = all.length; }
    } catch (e) { /* не нашли — уйдёт без названия и места */ }
  }
  ctx.waitUntil(tg(env, chat, fmtResult(row, c)));   // не заставляем ученика ждать телеграм
  return J({ ok: true, id });
}

// ── вход через Telegram: и из бота, и из браузера ──
// аккаунта нет — создаём молча; есть — просто впускаем
async function tgAuth(req, env) {
  const b = await req.json();
  const u = b.initData ? await checkInitData(env, b.initData)
          : b.widget   ? await checkWidget(env, b.widget)
          : null;
  if (!u || !u.id) return J({ error: 'bad_auth' }, 401);

  const tgid = String(u.id);
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 80) || 'id ' + tgid;
  const info = { name, username: u.username || null, photo_url: u.photo_url || null };

  let rows = await sb(env, `teachers?tg_chat_id=eq.${tgid}&select=id,name,username,photo_url&limit=1`);
  let t;
  if (rows.length) {
    t = rows[0];
    // имя в Telegram могли поменять — подтягиваем свежее
    if (t.name !== info.name || t.username !== info.username) {
      const up = await sb(env, `teachers?id=eq.${t.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(info)
      });
      t = up[0];
    }
  } else {
    const saved = await sb(env, 'teachers', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ tg_chat_id: tgid, ...info })
    });
    t = saved[0];
  }
  return J({ ok: true, token: await mkToken(env, t.id), me: pub(t) });
}

const pub = t => ({ name: t.name, username: t.username, photo_url: t.photo_url });

// ── проверка пропуска при возврате на сайт ──
async function me(req, env) {
  const id = await auth(env, await req.json());
  if (!id) return J({ error: 'auth' }, 401);
  const rows = await sb(env, `teachers?id=eq.${id}&select=name,username,photo_url&limit=1`);
  if (!rows.length) return J({ error: 'auth' }, 401);
  return J({ ok: true, me: pub(rows[0]) });
}

// ── учитель создаёт экзамен ──
async function createExam(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const t = await sb(env, `teachers?id=eq.${id}&select=tg_chat_id&limit=1`);
  if (!t.length) return J({ error: 'auth' }, 401);
  const code = genCode();
  const saved = await sb(env, 'exams', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      code,
      title: String(b.title || '').trim().slice(0, 120) || 'Imtihon',
      subjects: Array.isArray(b.subjects) && b.subjects.length ? b.subjects : ['math'],
      q_count: +b.q_count || 8,
      time_per_q: +b.time_per_q || 0,
      show_expl: !!b.show_expl,
      active_till: b.active_till || null,
      pack_id: b.pack_id ? +b.pack_id : null,   // из какого пакета брать вопросы
      teacher_id: id,
      teacher_chat_id: t[0].tg_chat_id     // берём из аккаунта, руками вводить не надо
    })
  });
  return J({ ok: true, code, exam: saved?.[0] ?? null });
}

// ── ученик открывает ссылку ?exam=CODE ──
async function getExam(env, code) {
  if (!code) return J({ error: 'code' }, 400);
  const rows = await sb(env,
    `exams?code=eq.${encodeURIComponent(code)}`
    + '&select=code,title,subjects,q_count,time_per_q,show_expl,active_till,pack_id&limit=1');
  if (!rows.length) return J({ error: 'not_found' }, 404);
  if (rows[0].active_till && new Date(rows[0].active_till) < new Date())
    return J({ error: 'expired' }, 410);
  return J({ ok: true, exam: rows[0] });
}

// ── статистика у учителя (она же проверка пароля при входе) ──
async function stats(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const n = Math.min(+b.limit || 100, 500);

  // только свои экзамены — чужие результаты учителю не видны
  const exams = await sb(env, `exams?teacher_id=eq.${id}&select=code,title&limit=200`);
  if (!exams.length) return J({ ok: true, results: [] });
  const byCode = {};
  for (const e of exams) byCode[e.code] = e.title;
  const list = '(' + exams.map(e => `"${e.code}"`).join(',') + ')';

  const results = await sb(env,
    `results?exam_code=in.${encodeURIComponent(list)}`
    + '&select=student,exam_code,total,correct,percent,grade_mark,duration_s,created_at'
    + `&order=created_at.desc&limit=${n}`);
  for (const r of results) r.exam_title = byCode[r.exam_code] || null;
  return J({ ok: true, results });
}

// ══════════ ЗАГРУЗКА МАТЕРИАЛА → ТЕСТЫ (Gemini + резерв) ══════════
// Учитель грузит файл (PDF/картинка) → ИИ читает → вопросы в questions (draft).

// строгая инструкция для модели: что вернуть и в каком виде
function ingestPrompt(lang) {
  const langNote = lang === 'ru'
    ? 'Сформулируй ВСЕ вопросы, варианты и пояснения на РУССКОМ языке.'
    : lang === 'uz'
    ? 'Barcha savollar, variantlar va izohlarni faqat OʻZBEK (lotin) tilida yoz.'
    : lang === 'en'
    ? 'Write ALL questions, options and explanations in ENGLISH.'
    : 'Сохрани язык оригинала материала.';
  return [
    'Ты — генератор тестов для учителя. Тебе дан учебный материал (текст или изображение).',
    'Задача: превратить его в тестовые вопросы с одним правильным ответом.',
    langNote,
    'Правила:',
    '1. Если в материале уже есть готовые вопросы с вариантами — извлеки их как есть.',
    '2. Если есть вопрос, но нет вариантов — придумай 4 правдоподобных варианта.',
    '3. Если правильный ответ указан в материале — используй его. Если нет — реши сам и поставь "ai_solved": true.',
    '4. У каждого вопроса ровно 4 варианта. Ровно один правильный.',
    '5. Дистракторы — правдоподобные, похожей длины, без "все верны" и абсурда.',
    '6. К каждому вопросу добавь короткое пояснение (1-2 предложения), почему ответ верный.',
    '7. SVG рисуй ТОЛЬКО если для решения задачи НЕОБХОДИМ рисунок: геометрическая фигура, график, схема, диаграмма, чертёж. Тогда воспроизведи его точно как SVG в поле "svg" (самодостаточный <svg ...>...</svg>, ~300x200, без внешних ссылок). ЗАПРЕЩЕНО: рисовать декоративные картинки (портреты, животные, фон), выдумывать изображения, которых нет в задании. Если рисунок не нужен для решения или его нет — поле "svg" НЕ добавляй.',
    '8. Обработай ВЕСЬ материал целиком — извлеки ВСЕ вопросы, которые есть в файле, не останавливайся на первом.',
    'Верни ТОЛЬКО валидный JSON без markdown, без пояснений вокруг. Формат:',
    '{"questions":[{"q":"текст вопроса","options":["A","B","C","D"],"correct":1,"explanation":"...","ai_solved":false,"svg":"<svg...>...</svg>"}]}',
    '"correct" — номер правильного варианта, СЧИТАЯ С ЕДИНИЦЫ (1 = первый).',
    'Если материал не годится для теста — верни {"questions":[]}.'
  ].join('\n');
}

// вызов Gemini (принимает и текст, и файл inline_data). Повтор при перегрузке.
async function callGemini(env, prompt, filePart) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('no_gemini_key');
  const MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
  const parts = [{ text: prompt }];
  if (filePart) parts.push({ inline_data: { mime_type: filePart.mime, data: filePart.b64 } });
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 12288, responseMimeType: 'application/json' }
  });
  let last = '';
  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 800));
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS[attempt]}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    );
    const t = await r.text();
    if (r.ok) {
      const j = JSON.parse(t);
      return j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    }
    last = `gemini ${r.status}: ${t}`;
    if (r.status !== 503 && r.status !== 429) break;   // повторяем только перегрузку
  }
  throw new Error(last);
}

// несколько файлов (страниц) в ОДНОМ запросе — ИИ видит весь материал сразу
async function callGeminiMulti(env, prompt, fileParts) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('no_gemini_key');
  const MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
  const parts = [{ text: prompt }];
  for (const fp of fileParts) parts.push({ inline_data: { mime_type: fp.mime, data: fp.b64 } });
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 12288, responseMimeType: 'application/json' }
  });
  let last = '';
  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 800));
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS[attempt]}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    );
    const t = await r.text();
    if (r.ok) {
      const j = JSON.parse(t);
      return j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    }
    last = `gemini ${r.status}: ${t}`;
    if (r.status !== 503 && r.status !== 429) break;
  }
  throw new Error(last);
}

// резерв: Groq (только текст). Используется, если Gemini недоступен и файл — текстовый.
async function callGroqText(env, prompt, text) {
  const key = env.GROQ_API_KEY;
  if (!key) throw new Error('no_groq_key');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text }
      ]
    })
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`groq ${r.status}: ${t}`);
  const j = JSON.parse(t);
  return j?.choices?.[0]?.message?.content || '';
}

// вытащить JSON из ответа модели (на случай мусора вокруг)
function parseModelJson(s) {
  if (!s) return null;
  let str = s.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try { return JSON.parse(str); } catch (e) {}
  const a = str.indexOf('{'), b = str.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(str.slice(a, b + 1)); } catch (e) {} }
  return null;
}

// прочитать тело файла из multipart/form-data
async function readUpload(req) {
  const form = await req.formData();
  const files = form.getAll('file').filter(f => f && typeof f !== 'string');
  const lang = String(form.get('lang') || '').toLowerCase();
  const teacherToken = String(form.get('token') || '');
  const packTitle = String(form.get('pack_title') || '').slice(0, 120);
  if (!files.length) return { error: 'no_file' };
  const parts = [];
  for (const file of files) {
    const mime = file.type || 'application/octet-stream';
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return { error: 'too_big' };
    parts.push({ mime, buf, name: file.name || 'file' });
  }
  return { files: parts, lang, teacherToken, packTitle, name: parts[0].name };
}

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toB64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : undefined;
    const c = i + 2 < len ? bytes[i + 2] : undefined;
    out += B64CHARS[a >> 2];
    out += B64CHARS[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    out += (b === undefined) ? '=' : B64CHARS[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    out += (c === undefined) ? '=' : B64CHARS[c & 63];
  }
  return out;
}

const isTextLike = mime =>
  mime.startsWith('text/') || mime.includes('json') || mime.includes('csv');

async function ingest(req, env) {
  const up = await readUpload(req);
  if (up.error) return J({ error: up.error }, 400);

  const teacherId = await readToken(env, up.teacherToken);
  if (!teacherId) return J({ error: 'auth' }, 401);

  const prompt = ingestPrompt(up.lang);

  // Все файлы идём ОДНИМ запросом к ИИ, чтобы вопросы, переходящие со страницы на страницу
  // (или из файла в файл), собирались правильно, а не рвались.
  let allQs = [];
  let lastErr = '';

  const inlineFiles = up.files.filter(f => f.mime.startsWith('image/') || f.mime === 'application/pdf').slice(0, 2);
  const textFiles   = up.files.filter(f => isTextLike(f.mime));

  // картинки/PDF — вместе одним вызовом (ИИ видит все страницы сразу)
  if (inlineFiles.length) {
    try {
      const fileParts = inlineFiles.map(f => ({ mime: f.mime, b64: toB64(f.buf) }));
      const raw = await callGeminiMulti(env, prompt, fileParts);
      const parsed = parseModelJson(raw);
      if (parsed && Array.isArray(parsed.questions)) allQs = allQs.concat(parsed.questions);
    } catch (e) { lastErr = String(e.message || e).slice(0, 300); }
  }

  // текстовые файлы — склеиваем в один текст
  if (textFiles.length) {
    try {
      let text = '';
      for (const f of textFiles) text += '\n\n' + new TextDecoder().decode(f.buf);
      text = text.slice(0, 60000);
      let raw = '';
      try { raw = await callGemini(env, prompt + '\n\nМАТЕРИАЛ:\n' + text, null); }
      catch (e) { raw = await callGroqText(env, prompt, text); }
      const parsed = parseModelJson(raw);
      if (parsed && Array.isArray(parsed.questions)) allQs = allQs.concat(parsed.questions);
    } catch (e) { lastErr = String(e.message || e).slice(0, 300); }
  }

  if (!allQs.length) {
    if (lastErr) return J({ error: 'ai: ' + lastErr, detail: lastErr }, 200);
    return J({ ok: true, inserted: 0, questions: [], pack_id: null });
  }
  const qs = allQs;

  // складываем распознанные вопросы черновиками.
  // Платформа универсальная: grade/subject/topic_id не заполняем (в базе они теперь nullable).
  const lang = (up.lang === 'ru' || up.lang === 'uz' || up.lang === 'en') ? up.lang : 'uz';

  // создаём пакет (одна загрузка = один пакет)
  const pack = await sb(env, 'packs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      teacher_id: teacherId,
      title: (up.packTitle || up.name || 'Yuklangan test').slice(0, 120),
      lang
    })
  });
  const packId = pack?.[0]?.id ?? null;

  const stamp = Date.now().toString(36);
  const rows = [];
  qs.slice(0, 60).forEach((q, i) => {
    const opts = Array.isArray(q.options) ? q.options.map(String).slice(0, 6) : [];
    if (!q.q || opts.length < 2) return;
    let correct = parseInt(q.correct, 10);
    if (!(correct >= 1 && correct <= opts.length)) correct = 1;
    const qtext = String(q.q).slice(0, 2000);
    const expl = q.explanation ? String(q.explanation).slice(0, 1000) : null;
    const svg = (q.svg && String(q.svg).trim().startsWith('<svg')) ? String(q.svg).slice(0, 20000) : null;
    // учитель выбрал один язык — кладём текст в обе колонки-пары одинаково
    rows.push({
      id: `up_${teacherId}_${stamp}_${i}`,
      format: 'single_choice',
      difficulty: 'medium',
      question_ru: qtext,
      question_uz: qtext,
      options_ru: opts,
      options_uz: opts,
      correct,
      explanation_ru: expl,
      explanation_uz: expl,
      status: 'draft',
      source: 'ai',
      teacher_id: teacherId,
      ai_solved: !!q.ai_solved,
      pack_id: packId,
      svg: svg
    });
  });

  if (!rows.length) return J({ ok: true, inserted: 0, questions: [], pack_id: packId });

  const saved = await sb(env, 'questions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rows)
  });

  return J({ ok: true, inserted: saved?.length || 0, pack_id: packId, questions: saved || [] });
}

// ── список пакетов учителя (для выбора при создании экзамена) ──
async function packs(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const rows = await sb(env,
    `packs?teacher_id=eq.${id}&select=id,title,lang,created_at&order=created_at.desc&limit=200`);
  // сколько approved-вопросов в каждом пакете
  const out = [];
  for (const p of rows) {
    const cnt = await sb(env,
      `questions?pack_id=eq.${p.id}&status=eq.approved&select=id`);
    out.push({ ...p, approved: Array.isArray(cnt) ? cnt.length : 0 });
  }
  return J({ ok: true, packs: out });
}

// ── вопросы пакета для ученика: случайные N из approved ──
async function packQuestions(env, packId, n) {
  if (!packId) return J({ error: 'pack' }, 400);
  const rows = await sb(env,
    `questions?pack_id=eq.${encodeURIComponent(packId)}&status=eq.approved`
    + '&select=question_ru,question_uz,options_ru,options_uz,correct,explanation_ru,explanation_uz,svg&limit=200');
  if (!rows || !rows.length) return J({ ok: true, questions: [] });
  // перемешиваем и берём N
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const take = n > 0 ? Math.min(n, rows.length) : rows.length;
  return J({ ok: true, questions: rows.slice(0, take) });
}

// ── черновики пакета (для проверки учителем) ──
async function draftQuestions(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const packId = +b.pack_id;
  if (!packId) return J({ error: 'pack' }, 400);
  const rows = await sb(env,
    `questions?pack_id=eq.${packId}&teacher_id=eq.${id}`
    + '&select=id,question_uz,question_ru,options_uz,options_ru,correct,explanation_uz,ai_solved,status,svg'
    + '&order=id');
  return J({ ok: true, questions: rows || [] });
}

// ── одобрить / изменить / удалить вопрос ──
async function editQuestion(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const qid = String(b.id || '');
  if (!qid) return J({ error: 'id' }, 400);
  // проверяем, что вопрос принадлежит этому учителю
  const own = await sb(env, `questions?id=eq.${encodeURIComponent(qid)}&teacher_id=eq.${id}&select=id&limit=1`);
  if (!own.length) return J({ error: 'not_found' }, 404);

  if (b.action === 'delete') {
    await sb(env, `questions?id=eq.${encodeURIComponent(qid)}`, { method: 'DELETE' });
    return J({ ok: true });
  }
  const patch = {};
  if (b.action === 'approve') patch.status = 'approved';
  if (b.question != null) { patch.question_uz = String(b.question).slice(0, 2000); patch.question_ru = patch.question_uz; }
  if (Array.isArray(b.options)) { const o = b.options.map(String).slice(0, 6); patch.options_uz = o; patch.options_ru = o; }
  if (b.correct != null) patch.correct = Math.max(1, +b.correct);
  if (!Object.keys(patch).length) return J({ error: 'nothing' }, 400);
  await sb(env, `questions?id=eq.${encodeURIComponent(qid)}`, {
    method: 'PATCH', body: JSON.stringify(patch)
  });
  return J({ ok: true });
}

// ── сводка по одному экзамену (аналитика класса) ──
async function examSummary(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const code = String(b.code || '').slice(0, 16);
  if (!code) return J({ error: 'code' }, 400);

  // экзамен должен принадлежать этому учителю
  const ex = await sb(env, `exams?code=eq.${encodeURIComponent(code)}&teacher_id=eq.${id}&select=code,title&limit=1`);
  if (!ex.length) return J({ error: 'not_found' }, 404);

  const rows = await sb(env,
    `results?exam_code=eq.${encodeURIComponent(code)}`
    + '&select=student,correct,total,percent,grade_mark,duration_s,answers,created_at&order=percent.desc&limit=1000');
  if (!rows.length) return J({ ok: true, exam: ex[0], summary: null });

  const n = rows.length;
  const avg = Math.round(rows.reduce((s, r) => s + (r.percent || 0), 0) / n);
  const avgTime = Math.round(rows.reduce((s, r) => s + (r.duration_s || 0), 0) / n);
  const grades = { 5: 0, 4: 0, 3: 0, 2: 0 };
  rows.forEach(r => { grades[r.grade_mark] = (grades[r.grade_mark] || 0) + 1; });

  // сложные вопросы: по answers считаем долю ошибок на каждый номер
  const qStat = {};   // idx -> {wrong, total}
  rows.forEach(r => {
    if (Array.isArray(r.answers)) {
      r.answers.forEach((a, i) => {
        if (!qStat[i]) qStat[i] = { wrong: 0, total: 0 };
        qStat[i].total++;
        if (!(a && a.ok)) qStat[i].wrong++;
      });
    }
  });
  const hard = Object.entries(qStat)
    .map(([i, v]) => ({ q: +i + 1, wrongPct: Math.round(v.wrong / v.total * 100), total: v.total }))
    .filter(x => x.wrongPct >= 50)
    .sort((a, b) => b.wrongPct - a.wrongPct)
    .slice(0, 5);

  return J({
    ok: true,
    exam: ex[0],
    summary: {
      count: n, avg, avgTime, grades,
      best: rows.slice(0, 3).map(r => ({ student: r.student, correct: r.correct, total: r.total, percent: r.percent })),
      worst: rows.slice(-3).reverse().map(r => ({ student: r.student, correct: r.correct, total: r.total, percent: r.percent })),
      hard
    }
  });
}

// ── список экзаменов учителя (для выбора в статистике) ──
async function myExams(req, env) {
  const b = await req.json();
  const id = await auth(env, b);
  if (!id) return J({ error: 'auth' }, 401);
  const rows = await sb(env,
    `exams?teacher_id=eq.${id}&select=code,title,created_at&order=created_at.desc&limit=200`);
  // число попыток по каждому
  const out = [];
  for (const e of rows) {
    const r = await sb(env, `results?exam_code=eq.${encodeURIComponent(e.code)}&select=student`);
    out.push({ ...e, attempts: Array.isArray(r) ? r.length : 0 });
  }
  return J({ ok: true, exams: out });
}

// ── ежедневная сводка (будильник) ──
async function dailySummary(env) {
  const exams = await sb(env,
    'exams?select=code,title,active_till,teacher_chat_id&order=created_at.desc&limit=50');
  const now = new Date();
  for (const ex of exams) {
    if (ex.active_till && new Date(ex.active_till) < now) continue;  // экзамен закончился
    const chat = ex.teacher_chat_id || env.TG_CHAT_ID;
    if (!chat) continue;
    const rows = await sb(env,
      `results?exam_code=eq.${encodeURIComponent(ex.code)}`
      + '&select=student,correct,total,percent&order=percent.desc&limit=500');
    if (!rows.length) continue;                                      // никто не проходил
    await tg(env, chat, fmtSummary(ex, rows));
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const p = url.pathname, m = req.method;
      if (m === 'POST' && p === '/api/result') return await postResult(req, env, ctx);
      if (m === 'POST' && p === '/api/tg-auth') return await tgAuth(req, env);
      if (m === 'POST' && p === '/api/me') return await me(req, env);
      if (m === 'POST' && p === '/api/exam') return await createExam(req, env);
      if (m === 'GET' && p === '/api/exam') return await getExam(env, url.searchParams.get('code'));
      if (m === 'POST' && p === '/api/stats') return await stats(req, env);
      if (m === 'POST' && p === '/api/exam-summary') return await examSummary(req, env);
      if (m === 'POST' && p === '/api/my-exams') return await myExams(req, env);
      if (m === 'POST' && p === '/api/ingest') return await ingest(req, env);
      if (m === 'POST' && p === '/api/packs') return await packs(req, env);
      if (m === 'POST' && p === '/api/drafts') return await draftQuestions(req, env);
      if (m === 'POST' && p === '/api/question') return await editQuestion(req, env);
      if (m === 'GET'  && p === '/api/pack-questions')
        return await packQuestions(env, url.searchParams.get('pack'), +url.searchParams.get('n') || 0);
      if (m === 'GET' && p === '/api/ai-test') {
        try {
          const out = await callGemini(env, 'Ответь одним словом: работает', null);
          return J({ ok: true, out });
        } catch (e) { return J({ ok: false, detail: String(e.message || e).slice(0, 500) }); }
      }
      return J({ error: 'not_found' }, 404);
    } catch (e) {
      return J({ error: String(e && e.message || e) }, 500);
    }
  },

  // срабатывает по расписанию из wrangler.jsonc
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailySummary(env));
  }
};
