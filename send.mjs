// Manda los avisos de OpoCamper. Lo ejecuta una tarea programada de GitHub cada ~10 minutos.
// Avisos: te retan, te han adelantado hoy, racha en peligro (21 h) y domingo por la tarde.
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

await stateRef.set({ ...patch, lastRun: now }, { merge: true });
console.log('Avisos enviados:', sent);
