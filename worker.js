const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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

async function tg(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { }
}

const SUBJ = { math: 'Matematika', critical: 'Mantiq', english: 'Ingliz tili' };

function fmt(r) {
  const dot = r.percent >= 80 ? '🟢' : r.percent >= 50 ? '🟡' : '🔴';
  const m = Math.floor((r.duration_s || 0) / 60);
  const s = (r.duration_s || 0) % 60;
  const dur = r.duration_s ? ` · ${m}:${String(s).padStart(2, '0')}` : '';
  return `${dot} <b>${esc(r.student)}</b>\n`
    + `Fan: ${esc(SUBJ[r.subject] || r.subject)}\n`
    + `Natija: <b>${r.correct}/${r.total}</b> (${r.percent}%) · baho ${r.grade_mark}${dur}`
    + (r.exam_code ? `\nImtihon: <code>${esc(r.exam_code)}</code>` : '');
}

const genCode = () => Array.from(
  crypto.getRandomValues(new Uint8Array(5)),
  b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 30]
).join('');

const ok = (env, pass) => env.TEACHER_PASSWORD && pass === env.TEACHER_PASSWORD;

async function postResult(req, env, ctx) {
  const b = await req.json();
  const total = Math.max(0, Math.min(200, +b.total || 0));
  const correct = Math.max(0, Math.min(total, +b.correct || 0));
  const percent = total ? Math.round(correct / total * 100) : 0;
  const row = {
    exam_code: b.exam_code ? String(b.exam_code).slice(0, 16) : null,
    student: String(b.student || '').trim().slice(0, 80) || '—',
    subject: String(b.subject || '').slice(0, 40),
    lang: b.lang === 'ru' ? 'ru' : 'uz',
    total,
    correct,
    percent,
    grade_mark: percent >= 90 ? 5 : percent >= 70 ? 4 : percent >= 50 ? 3 : 2,
    duration_s: b.duration_s != null ? +b.duration_s : null,
    answers: b.answers ?? null
  };
  const saved = await sb(env, 'results', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  ctx.waitUntil(tg(env, fmt(row)));
  return J({ ok: true, id: saved?.[0]?.id ?? null });
}

async function createExam(req, env) {
  const b = await req.json();
  if (!ok(env, b.password)) return J({ error: 'auth' }, 401);
  if (!Array.isArray(b.subjects) || !b.subjects.length) return J({ error: 'subjects' }, 400);
  const code = genCode();
  const saved = await sb(env, 'exams', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      code,
      title: String(b.title || '').trim().slice(0, 120) || 'Imtihon',
      subjects: b.subjects,
      q_count: +b.q_count || 15,
      time_per_q: +b.time_per_q || 0,
      show_expl: !!b.show_expl,
      active_till: b.active_till || null
    })
  });
  return J({ ok: true, code, exam: saved?.[0] ?? null });
}

async function getExam(env, code) {
  if (!code) return J({ error: 'code' }, 400);
  const rows = await sb(env, `exams?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
  if (!rows.length) return J({ error: 'not_found' }, 404);
  if (rows[0].active_till && new Date(rows[0].active_till) < new Date())
    return J({ error: 'expired' }, 410);
  return J({ ok: true, exam: rows[0] });
}

async function stats(req, env) {
  const b = await req.json();
  if (!ok(env, b.password)) return J({ error: 'auth' }, 401);
  const n = Math.min(+b.limit || 100, 500);
  const results = await sb(env,
    'results?select=student,subject,total,correct,percent,grade_mark,duration_s,created_at'
    + `&order=created_at.desc&limit=${n}`);
  return J({ ok: true, results });
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
  }
};
