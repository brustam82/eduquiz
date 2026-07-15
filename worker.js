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
function fmtResult(r) {
  const dot = r.percent >= 80 ? '🟢' : r.percent >= 50 ? '🟡' : '🔴';
  const m = Math.floor((r.duration_s || 0) / 60);
  const s = (r.duration_s || 0) % 60;
  const dur = r.duration_s ? ` · ${m}:${String(s).padStart(2, '0')}` : '';
  return `${dot} <b>${esc(r.student)}</b>\n`
    + `Natija: <b>${r.correct}/${r.total}</b> (${r.percent}%) · baho ${r.grade_mark}${dur}`
    + (r.exam_code ? `\nImtihon: <code>${esc(r.exam_code)}</code>` : '');
}

function fmtSummary(ex, rows) {
  const avg = Math.round(rows.reduce((s, r) => s + (r.percent || 0), 0) / rows.length);
  const medal = ['🥇', '🥈', '🥉'];
  const top = rows.slice(0, 3)
    .map((r, i) => `${medal[i]} ${esc(r.student)} — ${r.correct}/${r.total} (${r.percent}%)`)
    .join('\n');
  let t = `📊 <b>${esc(ex.title || ex.code)}</b> — kunlik hisobot\n\n`
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

const ok = (env, pass) => env.TEACHER_PASSWORD && pass === env.TEACHER_PASSWORD;

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

  // куда слать: телеграм учителя из экзамена, иначе общий из секретов
  let chat = env.TG_CHAT_ID;
  if (row.exam_code) {
    try {
      const ex = await sb(env,
        `exams?code=eq.${encodeURIComponent(row.exam_code)}&select=teacher_chat_id&limit=1`);
      if (ex && ex[0] && ex[0].teacher_chat_id) chat = ex[0].teacher_chat_id;
    } catch (e) { /* не нашли — уйдёт в общий чат */ }
  }
  ctx.waitUntil(tg(env, chat, fmtResult(row)));   // не заставляем ученика ждать телеграм
  return J({ ok: true, id: saved?.[0]?.id ?? null });
}

// ── учитель создаёт экзамен ──
async function createExam(req, env) {
  const b = await req.json();
  if (!ok(env, b.password)) return J({ error: 'auth' }, 401);
  const code = genCode();
  const tgid = b.teacher_chat_id ? String(b.teacher_chat_id).trim().slice(0, 32) : '';
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
      teacher_chat_id: /^-?\d+$/.test(tgid) ? tgid : null
    })
  });
  return J({ ok: true, code, exam: saved?.[0] ?? null });
}

// ── ученик открывает ссылку ?exam=CODE ──
async function getExam(env, code) {
  if (!code) return J({ error: 'code' }, 400);
  const rows = await sb(env,
    `exams?code=eq.${encodeURIComponent(code)}`
    + '&select=code,title,subjects,q_count,time_per_q,show_expl,active_till&limit=1');
  if (!rows.length) return J({ error: 'not_found' }, 404);
  if (rows[0].active_till && new Date(rows[0].active_till) < new Date())
    return J({ error: 'expired' }, 410);
  return J({ ok: true, exam: rows[0] });
}

// ── статистика у учителя (она же проверка пароля при входе) ──
async function stats(req, env) {
  const b = await req.json();
  if (!ok(env, b.password)) return J({ error: 'auth' }, 401);
  const n = Math.min(+b.limit || 100, 500);
  const results = await sb(env,
    'results?select=student,subject,total,correct,percent,grade_mark,duration_s,created_at'
    + `&order=created_at.desc&limit=${n}`);
  return J({ ok: true, results });
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
      if (m === 'POST' && p === '/api/exam') return await createExam(req, env);
      if (m === 'GET' && p === '/api/exam') return await getExam(env, url.searchParams.get('code'));
      if (m === 'POST' && p === '/api/stats') return await stats(req, env);
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
