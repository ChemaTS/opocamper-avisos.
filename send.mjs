// Manda los avisos de OpoCamper. Lo ejecuta una tarea programada de GitHub cada ~10 minutos.
// Avisos: "te retan" (retos y duelos nuevos) y domingo por la tarde "cierra la semana".
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
  const res = await fcm.sendEachForMulticast({ tokens, data: { title, body, tag, url: '/' }, webpush: { headers: { Urgency: 'high' } } });
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

// 2) Domingo por la tarde (18:00-21:00 hora de Madrid), una vez por semana
const madrid = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(new Date()).reduce((o, p) => ((o[p.type] = p.value), o), {});
const today = `${madrid.year}-${madrid.month}-${madrid.day}`;
const hour = Number(madrid.hour);
if (madrid.weekday === 'Sun' && hour >= 18 && hour < 21 && state.weeklyDay !== today) {
  const users = await db.collection('users').get();
  for (const u of users.docs) await send(u.id, 'Última tarde de la semana', 'Esta noche se decide el premio semanal. ¿Un último bloque?', 'semana');
  await stateRef.set({ weeklyDay: today }, { merge: true });
}

await stateRef.set({ lastRun: now }, { merge: true });
console.log('Avisos enviados:', sent);
