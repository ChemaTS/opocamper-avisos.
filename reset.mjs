// Reinicio del curso de OpoCamper: todos empiezan de cero.
// Lo lanza a mano la tarea "Reiniciar curso" (reset.yml). Sin CONFIRM=REINICIAR solo cuenta lo que borraría.
// Se queda: grupo e invitación, banco, preguntas del grupo, avisos "esto está mal", tokens de avisos.
// Se borra: sesiones, puntuaciones de días y semanas, victorias, postales, retos, duelos, reto del día, bote,
// garaje, semáforo, simulacros, muro, empujoncitos y, de cada usuario, horas/sellos, objetos, mejoras y camper.
// Las cuentas de prueba anónimas (Probador) se borran enteras.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ credential: applicationDefault(), projectId: 'opocamper' });
const db = getFirestore();
const auth = getAuth();
const GO = process.env.CONFIRM === 'REINICIAR';
const MODE = process.env.MODE || 'keep_pet'; // keep_pet | no_pet | full
console.log(GO ? 'REINICIANDO DE VERDAD' : 'SIMULACRO (no se borra nada)', 'modo', MODE);

const counts = {};
const add = (k, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

async function wipe(path) {
  const ref = db.collection(path);
  const docs = await ref.listDocuments();
  add(path, docs.length);
  if (GO) for (const d of docs) await db.recursiveDelete(d);
}

for (const c of ['sessions', 'days', 'weeks', 'weekCards', 'challenges', 'duels', 'dailies', 'plan', 'garage', 'simulacros', 'feed', 'nudges']) await wipe(c);
if (GO) await db.doc('pot/main').set({ amount: 0 });
if (GO) await db.doc('meta/push').set({ lastRun: FieldValue.serverTimestamp() });

const users = await db.collection('users').get();
for (const u of users.docs) {
  const p = u.data();
  let anon = false;
  try { anon = (await auth.getUser(u.id)).providerData.length === 0; } catch { anon = !p.email; }
  if (anon || MODE === 'full') {
    add(anon ? 'usuarios de prueba borrados' : 'usuarios borrados');
    console.log(anon ? 'Borro cuenta de prueba' : 'Borro usuario', p.displayName, u.id);
    if (GO) {
      await db.recursiveDelete(u.ref);
      await db.doc(`pushTokens/${u.id}`).delete();
      if (anon) await auth.deleteUser(u.id).catch(() => {});
    }
    continue;
  }
  add('usuarios a cero');
  console.log('A cero', p.displayName, u.id, `(${p.points} puntos, racha ${p.streak})`);
  if (!GO) continue;
  for (const sub of await u.ref.listCollections()) await db.recursiveDelete(sub);
  await u.ref.update({
    points: 0, streak: 0, longestStreak: 0, lastStreakDay: '', lifelinesSaved: 0, status: '', statusAt: FieldValue.delete(),
    currentWorld: 'sonido', openSessionId: '', lastBlockEndedAt: null, lastMultTenths: 10, lastSession: null,
    kitClaimed: false, chDay: FieldValue.delete(), chCount: FieldValue.delete(), chCombo: FieldValue.delete(),
    lastClaim: FieldValue.delete(), lastStake: FieldValue.delete(), lastPurchase: FieldValue.delete(),
    camperColor: 'turquesa', lastActiveAt: FieldValue.serverTimestamp(),
    ...(MODE === 'no_pet' ? { pet: FieldValue.delete() } : {}),
  });
}

console.log('Resumen:', JSON.stringify(counts));
