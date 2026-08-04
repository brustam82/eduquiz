const n = Math.round((r.percent || 0) / 10);
const bar = '█'.repeat(n) + '░'.repeat(10 - n);

  const tbl = [
    `${pad('Jami savollar', 22)}${r.total}`,
    `${pad("To'g'ri javoblar", 22)}${r.correct}`,
    `${pad('Xato javoblar', 22)}${wrong}`,
    `${pad('Natija', 22)}${r.percent}%`,
    `${pad('Baho', 22)}${r.grade_mark} (${mark})`,
    `${pad('Sarflangan vaqt', 22)}${timeWords(r.duration_s)}`
  ].join('\n');
  // аналитический вывод по результату
  const verdict = r.percent >= 90 ? "Mavzu to'liq o'zlashtirilgan. O'quvchi materialni mustahkam biladi."
    : r.percent >= 70 ? "Mavzu yaxshi o'zlashtirilgan. Ayrim savollarda kichik xatoliklar kuzatildi."
    : r.percent >= 50 ? "Mavzu qisman o'zlashtirilgan. Xato qilingan mavzularni qayta ko'rib chiqish tavsiya etiladi."
    : "Mavzu yetarli darajada o'zlashtirilmagan. O'quvchi bilan qo'shimcha mashg'ulot o'tkazish tavsiya etiladi.";

const L = [];
L.push('🏛 <b>MUALLIMTEST</b>');
L.push('<i>Imtihon natijasi to\'g\'risida ma\'lumot</i>');
L.push('');
  L.push(`👤 <b>${esc(r.student)}</b>`);
  if (c.title) L.push(`📘 ${esc(c.title)}`);
  if (r.exam_code) L.push(`🔑 Imtihon kodi: <code>${esc(r.exam_code)}</code>`);
  L.push(`👤 <b>FIO:</b> ${esc(r.student)}`);
  if (c.title) L.push(`📘 <b>Imtihon nomi:</b> ${esc(c.title)}`);
  if (r.exam_code) L.push(`🔑 <b>Imtihon kodi:</b> <code>${esc(r.exam_code)}</code>`);
  L.push('');
  L.push(`📝 <b>Jami savollar soni:</b> ${r.total} ta`);
  L.push(`✅ <b>To'g'ri javoblar:</b> ${r.correct} ta`);
  L.push(`❌ <b>Xato javoblar:</b> ${wrong} ta`);
  L.push(`🎯 <b>Baho:</b> ${r.grade_mark} — ${mark}`);
  L.push(`⏱ <b>Sarflangan vaqt:</b> ${timeWords(r.duration_s)}`);
  if (c.rank) L.push(`🏅 <b>Guruhdagi o'rni:</b> ${c.rank} / ${c.of}`);
  L.push('');
  L.push(`${dot} <b>Umumiy natija:</b> ${r.percent}%`);
  L.push(`<code>${bar}</code>`);
L.push('');
  L.push(`<pre>${tbl}</pre>`);
  L.push(`${dot} <code>${bar}</code> ${r.percent}%`);
  L.push(`<blockquote>📊 <b>Xulosa.</b> ${verdict}</blockquote>`);

  const extra = [];
  if (r.duration_s && r.total && r.duration_s / r.total < 5)
    extra.push('⚠️ Javoblar juda tez berilgan — tekshirish tavsiya etiladi.');
if (Array.isArray(r.answers)) {
const bad = r.answers.map((a, i) => (a && a.ok ? null : i + 1)).filter(Boolean);
    if (bad.length) extra.push(`📌 Xato qilingan savollar: ${bad.join(', ')}`);
    if (bad.length) L.push(`📌 <b>Xato qilingan savol raqamlari:</b> ${bad.join(', ')}`);
}
  if (c.rank) extra.push(`🏅 Guruhda egallagan o'rni: ${c.rank} / ${c.of}`);
  if (extra.length) { L.push(''); L.push(`<blockquote>${extra.join('\n')}</blockquote>`); }
  if (r.duration_s && r.total && r.duration_s / r.total < 5)
    L.push(`\n⚠️ <i>Eslatma: har bir savolga o'rtacha ${Math.round(r.duration_s / r.total)} soniya sarflangan. Javoblar tez berilgani sababli natijani qo'shimcha tekshirish tavsiya etiladi.</i>`);

return L.join('\n');
}
@@ -101,40 +104,47 @@ function fmtSummary(ex, rows) {
const g = { 5: 0, 4: 0, 3: 0, 2: 0 };
rows.forEach(r => { g[r.grade_mark] = (g[r.grade_mark] || 0) + 1; });
const tot = rows.length;
  const passed = rows.filter(r => (r.percent || 0) >= 50).length;
  const passPct = Math.round(passed / tot * 100);
const barOf = v => { const n = tot ? Math.round(v / tot * 10) : 0; return '█'.repeat(n) + '░'.repeat(10 - n); };
  const dot = avg >= 80 ? '🟢' : avg >= 50 ? '🟡' : '🔴';

  const tbl = [
    `${pad('Qatnashganlar', 22)}${tot} o'quvchi`,
    `${pad("O'rtacha natija", 22)}${avg}%`,
    `${pad("O'rtacha vaqt", 22)}${timeWords(avgTime)}`
  ].join('\n');

  const grades = [
    `5  A'lo        ${barOf(g[5])}  ${g[5]}`,
    `4  Yaxshi      ${barOf(g[4])}  ${g[4]}`,
    `3  Qoniqarli   ${barOf(g[3])}  ${g[3]}`,
    `2  Qoniqarsiz  ${barOf(g[2])}  ${g[2]}`
  ].join('\n');
  const verdict = avg >= 80
    ? "Guruh mavzuni yuqori darajada o'zlashtirgan. Natijalar barqaror."
    : avg >= 65
    ? "Guruhning umumiy tayyorgarligi qoniqarli. Ayrim o'quvchilar bilan qo'shimcha ishlash tavsiya etiladi."
    : avg >= 50
    ? "Guruh mavzuni qisman o'zlashtirgan. Xato ko'p uchragan mavzularni takrorlash zarur."
    : "Guruhning natijasi past. Mavzuni qaytadan tushuntirish va mustahkamlash tavsiya etiladi.";

const L = [];
L.push('🏛 <b>MUALLIMTEST</b>');
L.push('<i>Kunlik umumiy hisobot</i>');
L.push('');
  L.push(`📘 <b>${esc(ex.title)}</b>`);
  L.push(`🔑 Imtihon kodi: <code>${esc(ex.code)}</code>`);
  L.push(`📘 <b>Imtihon nomi:</b> ${esc(ex.title)}`);
  L.push(`🔑 <b>Imtihon kodi:</b> <code>${esc(ex.code)}</code>`);
  L.push('');
  L.push(`👥 <b>Imtihon topshirganlar:</b> ${tot} o'quvchi`);
  L.push(`${dot} <b>Guruhning o'rtacha natijasi:</b> ${avg}%`);
  L.push(`✅ <b>50% dan yuqori natija ko'rsatganlar:</b> ${passed} ta (${passPct}%)`);
  L.push(`⏱ <b>O'rtacha sarflangan vaqt:</b> ${timeWords(avgTime)}`);
L.push('');
  L.push(`<pre>${tbl}</pre>`);
L.push('<b>Baholar taqsimoti</b>');
  L.push(`<pre>${grades}</pre>`);
  L.push(`<code>5  A'lo        ${barOf(g[5])}  ${g[5]} ta</code>`);
  L.push(`<code>4  Yaxshi      ${barOf(g[4])}  ${g[4]} ta</code>`);
  L.push(`<code>3  Qoniqarli   ${barOf(g[3])}  ${g[3]} ta</code>`);
  L.push(`<code>2  Qoniqarsiz  ${barOf(g[2])}  ${g[2]} ta</code>`);
  L.push('');
L.push('<b>Eng yuqori natijalar</b>');
rows.slice(0, 3).forEach((r, i) => {
L.push(`${medal[i]} ${esc(r.student)} — ${r.correct}/${r.total} (${r.percent}%)`);
});
  L.push('');
  L.push(`<blockquote>📊 <b>Tahliliy xulosa.</b> ${verdict}</blockquote>`);

if (ex.active_till) {
const d = new Date(ex.active_till).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
    L.push('');
    L.push(`<blockquote>⏳ Imtihon yakunlanadi: ${d}</blockquote>`);
    L.push(`⏳ <b>Imtihon yakunlanadi:</b> ${d}`);
}
return L.join('\n');
}
