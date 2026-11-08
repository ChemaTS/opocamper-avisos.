// Manda los avisos de OpoCamper. Lo ejecuta una tarea programada de GitHub cada ~10 minutos.
// Avisos: te retan, hoguera, postal de la semana (lunes) en tu mundo, empujoncito, te han adelantado hoy, racha en peligro (21 h) y domingo por la tarde.
// Además reparte los premios del Gran Premio al cerrar cada semana.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

initializeApp({ credential: applicationDefault(), projectId: 'opocamper' });
const db = getFirestore();
const fcm = getMessaging();

const stateRef = db.doc('meta/push');
const state = (await stateRef.get()).data() ?? {};
const now = Timestamp.now();
// Primera vez: solo lo de la última hora.
const since = state.lastRun ?? Timestamp.fromMillis(now.toMillis() - 3600_000);

const names = new Map();
const nameOf = async (uid) => {
  if (!names.has(uid)) names.set(uid, ((await db.doc(`users/${uid}`).get()).data()?.displayName ?? 'Alguien').split(' ')[0]);
  return names.get(uid);
};
const tokensOf = async (uid) => (await db.doc(`pushTokens/${uid}`).get()).data()?.tokens ?? [];

let sent = 0;
async function send(uid, title, body, tag) {
  const tokens = await tokensOf(uid);
  if (!tokens.length) return;
  const res = await fcm.sendEachForMulticast({
    tokens,
    data: { title, body, tag, url: '/' },
    webpush: {
      headers: { Urgency: 'high' },
      notification: { title, body, tag, icon: 'https://opocamper.web.app/assets/icono_app_192.png' },
      fcmOptions: { link: 'https://opocamper.web.app/' },
    },
  });
  console.log(uid, 'ok', res.successCount, 'fallos', res.failureCount, res.responses.filter((r) => !r.success).map((r) => r.error?.code).join(','));
  const dead = res.responses
    .map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null))
    .filter(Boolean);
  if (dead.length) await db.doc(`pushTokens/${uid}`).update({ tokens: FieldValue.arrayRemove(...dead) });
  sent += res.successCount;
}

// 0) Prueba manual: aviso de prueba a los administradores
if (process.env.TEST_ADMINS === 'true') {
  const admins = await db.collection('users').where('isAdmin', '==', true).get();
  for (const u of admins.docs) await send(u.id, 'Prueba de avisos', '¡Los avisos de OpoCamper funcionan!', 'prueba');
}

// 1) Te retan
for (const col of ['challenges', 'duels']) {
  const snap = await db.collection(col).where('createdAt', '>', since).where('createdAt', '<=', now).get();
  for (const d of snap.docs) {
    const c = d.data();
    const who = await nameOf(c.from);
    const what = col === 'duels' ? 'a un duelo' : c.kind === 'supuesto' ? 'con un supuesto' : 'con una pregunta';
    await send(c.to, `${who} te reta ${what}`, 'Tienes 24 horas para responder. ¡A por ello!', `reto-${d.id}`);
  }
}

// Hora y fecha de Madrid
const madrid = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(new Date()).reduce((o, p) => ((o[p.type] = p.value), o), {});
const today = `${madrid.year}-${madrid.month}-${madrid.day}`;
const hour = Number(madrid.hour) % 24;
const prevDay = (id) => { const [y, m, d] = id.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); };
function weekId(id) {
  const [y, m, day] = id.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-W${String(Math.ceil(((date - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
const ranking = async (path) => (await db.collection(path).get()).docs
  .map((d) => ({ uid: d.id, points: d.data().points ?? 0 }))
  .filter((r) => r.points > 0)
  .sort((a, b) => b.points - a.points);
const patch = {};

// 2) Te han adelantado hoy (al que iba primero, como mucho una vez al día, de 9 a 22 h)
if (hour >= 9 && hour < 22) {
  const day = await ranking(`days/${today}/scores`);
  const leader = day[0]?.uid ?? null;
  const prev = state.leader?.day === today ? state.leader.uid : null;
  const notified = state.overtaken?.day === today ? state.overtaken.uids ?? [] : [];
  if (leader && prev && prev !== leader && !notified.includes(prev)) {
    const mine = day.find((r) => r.uid === prev)?.points ?? 0;
    await send(prev, `${await nameOf(leader)} te ha adelantado hoy`, `Va ${day[0].points - mine} puntos por delante. ¿Un bloque más para recuperar la banderita?`, 'adelantado');
    patch.overtaken = { day: today, uids: [...notified, prev] };
  }
  patch.leader = { day: today, uid: leader };
}

// 3) Racha en peligro (21 h, una vez al día): racha viva que hoy aún no ha contado
if (hour === 21 && state.streakDay !== today) {
  const users = await db.collection('users').where('streak', '>', 0).get();
  for (const u of users.docs) {
    const p = u.data();
    if (p.lastStreakDay === today || p.lastStreakDay !== prevDay(today)) continue;
    const extra = p.lifelinesSaved > 0 ? ' Si no, gastarás un salvavidas.' : '';
    await send(u.id, `Tu racha de ${p.streak} días está en peligro`, `Un choque de puños, un reto o el reto del día y la salvas.${extra}`, 'racha');
  }
  patch.streakDay = today;
}

// 4) Domingo por la tarde (18-21 h, una vez): cómo vas en la semana
if (madrid.weekday === 'Sun' && hour >= 18 && hour < 21 && state.weeklyDay !== today) {
  const week = await ranking(`weeks/${weekId(today)}/scores`);
  const users = await db.collection('users').get();
  for (const u of users.docs) {
    const pos = week.findIndex((r) => r.uid === u.id);
    const body = pos === 0
      ? `Vas primero${week[1] ? ` con ${week[0].points - week[1].points} puntos de ventaja` : ''}. Esta noche se decide el premio: ¡aguanta!`
      : pos > 0
        ? `Vas ${pos + 1}º, a ${week[0].points - week[pos].points} puntos de ${await nameOf(week[0].uid)}. Esta noche se decide el premio.`
        : 'Esta noche se decide el premio semanal. ¿Un último bloque?';
    await send(u.id, 'Última tarde de la semana', body, 'semana');
  }
  patch.weeklyDay = today;
}

// 5) Hoguera: alguien empieza a estudiar -> aviso al resto (8 a 23 h, como mucho uno cada 3 h por persona)
if (hour >= 8 && hour < 23) {
  const WORLD = { luz: 'Luz', fotografia: 'Fotografía', laboratorio: 'Laboratorio', cine: 'Cine', television: 'Televisión', sonido: 'Sonido', radio: 'Radio' };
  const fresh = (await db.collection('sessions').where('startedAt', '>', since).get()).docs
    .map((d) => d.data()).filter((s) => s.status === 'open' && !s.test);
  if (fresh.length) {
    const alive = (await db.collection('sessions').where('status', '==', 'open').get()).docs
      .map((d) => d.data()).filter((s) => !s.test && now.toMillis() - (s.lastBumpAt?.toMillis() ?? 0) < 16 * 60_000);
    const studying = new Set(alive.map((s) => s.uid));
    const fireSent = { ...(state.fireSent ?? {}) };
    const users = await db.collection('users').get();
    for (const u of users.docs) {
      if (studying.has(u.id) || now.toMillis() - (fireSent[u.id] ?? 0) < 3 * 3600_000) continue;
      const s = fresh.find((f) => f.uid !== u.id);
      if (!s) continue;
      const there = [...new Set(alive.filter((a) => a.world === s.world).map((a) => a.uid))];
      const who = await Promise.all(there.map(nameOf));
      const world = WORLD[s.world] ?? s.world;
      const title = there.length >= 2 ? `Hoguera en ${world}` : `${await nameOf(s.uid)} está estudiando en ${world}`;
      const body = there.length >= 2
        ? `${who.join(' y ')} están estudiando juntos. Únete: +15 por choque.`
        : 'Únete ahora y encended la hoguera: +15 por choque mientras estudiéis a la vez.';
      await send(u.id, title, body, 'hoguera');
      fireSent[u.id] = now.toMillis();
    }
    patch.fireSent = fireSent;
  }
}

// 6) Lunes de 9 a 12 h (una vez): ya están las postales de la semana
if (madrid.weekday === 'Mon' && hour >= 9 && hour < 12 && state.postDay !== today) {
  const lw = weekId(prevDay(prevDay(today)));
  const scored = (await db.collection(`weeks/${lw}/scores`).get()).docs.filter((d) => (d.data().minutes ?? 0) > 0).map((d) => d.id);
  const users = await db.collection('users').get();
  for (const u of users.docs) {
    const body = scored.includes(u.id) ? 'Tu postal con la semana pasada te espera. ¡Mira cómo has ido y aplaude a los demás!' : 'Mira cómo les fue a los demás y aplaude su esfuerzo. ¿Esta semana sales tú?';
    await send(u.id, 'Postales de la semana', body, 'postal-semana');
  }
  patch.postDay = today;
}

// 7) Empujoncito: un compañero te da un toque porque hoy aún no has estudiado
{
  const snap = await db.collection('nudges').where('at', '>', since).where('at', '<=', now).get();
  for (const d of snap.docs) {
    const n = d.data();
    const studied = ((await db.doc(`days/${n.day}/scores/${n.to}`).get()).data()?.minutes ?? 0) > 0;
    if (studied) continue;
    await send(n.to, `👉 ${await nameOf(n.from)} te da un empujoncito`, 'Hoy aún no has arrancado. Un bloque de 15 minutos y a por la racha.', `empujon-${d.id}`);
  }
}

// 8) Gran Premio: al cerrar (domingo 21:00) reparte premios. Todo se recalcula desde las respuestas guardadas,
// con las mismas reglas que la app (src/lib/gp.ts). Una pregunta retirada no cuenta para nadie.
{
  const GAIN = { n: [3, 10], t: [-15, 25] }, TURBO_NEED = 2, PRIZE = [180, 120, 60, 20], BONUS = 25;
  const open = (await db.collection('gp').where('closesAt', '<=', now).get()).docs.filter((d) => !d.data().settled);
  if (open.length) {
    const reports = (await db.collection('reports').get()).docs.map((d) => d.data());
    const voided = new Set(reports.filter((r) => r.status === 'descartada' || (r.status === 'open' && 1 + Object.keys(r.extra ?? {}).length >= 2)).map((r) => r.qid));
    for (const g of open) {
      const gp = g.data();
      const runs = (await g.ref.collection('runs').get()).docs.map((d) => d.data()).filter((r) => r.done || Object.keys(r.a ?? {}).length);
      const rows = runs.map((r) => {
        let m = 0, secs = 0, streak = 0;
        for (let i = 0; i < gp.qids.length; i++) {
          const a = r.a?.[String(i)];
          if (!a) continue;
          const [c0, ok, s] = a;
          secs += Math.min(30, Math.max(0, s ?? 30));
          if (voided.has(gp.qids[i])) continue;
          const c = c0 === 't' && streak < TURBO_NEED ? 'n' : c0;
          m = Math.max(0, m + GAIN[c][ok ? 1 : 0]);
          streak = c === 't' || !ok ? 0 : streak + 1;
        }
        return { uid: r.uid, m, secs, at: r.startedAt?.toMillis() ?? 0, bonus: 0 };
      });
      // Récord: el que va primero en cada momento se lleva 25 por cada uno que no le supera.
      let holder = null;
      for (const r of [...rows].sort((a, b) => a.at - b.at)) {
        if (holder && (r.m < holder.m || (r.m === holder.m && r.secs >= holder.secs))) holder.bonus += BONUS;
        else holder = r;
      }
      rows.sort((a, b) => b.m - a.m || a.secs - b.secs);
      const paid = rows.length >= 2;
      const results = rows.map((r, i) => ({ uid: r.uid, m: r.m, secs: r.secs, pos: i + 1, prize: paid ? PRIZE[Math.min(i, PRIZE.length - 1)] : 0, bonus: r.bonus }));
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(gp.closesAt.toDate());
      const b = db.batch();
      for (const r of results) {
        const gain = r.prize + r.bonus;
        if (gain <= 0) continue;
        const data = { uid: r.uid, sessionId: `gp:${gp.week}`, points: FieldValue.increment(gain), minutes: FieldValue.increment(0), bumps: FieldValue.increment(0) };
        b.update(db.doc(`users/${r.uid}`), { points: FieldValue.increment(gain) });
        b.set(db.doc(`days/${day}/scores/${r.uid}`), data, { merge: true });
        b.set(db.doc(`weeks/${gp.week}/scores/${r.uid}`), data, { merge: true });
      }
      b.update(g.ref, { settled: true, results, settledAt: now });
      if (results.length) {
        const w = results[0];
        const text = paid ? `🏁 ¡Gana el Gran Premio con ${w.m} m! Se lleva ${w.prize + w.bonus} puntos.` : `🏁 Corre solo el Gran Premio: ${w.m} m.`;
        b.set(db.collection('feed').doc(), { uid: w.uid, kind: 'win', text, tags: [], at: now, r: {} });
      }
      await b.commit();
      console.log('Gran Premio', gp.week, 'repartido:', results.map((r) => `${r.uid}:${r.m}m+${r.prize}+${r.bonus}`).join(' '));
    }
  }
}

await stateRef.set({ ...patch, lastRun: now }, { merge: true });
console.log('Avisos enviados:', sent);
