// ================================================================
// notify.js — Keuangan Pro Push Notification Engine
// Dijalankan oleh GitHub Actions setiap menit
// ================================================================

// notify.js

// === BAGIAN UPDATE UTAMA UNTUK MEMBACA KREDENSIAL ===
const admin = require('firebase-admin'); 
// Buat objek kredensial dari environment variable USER
const serviceAccount = {
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL, // Gunakan nama variabel kamu
  // Kita perlu menangani baris baru (\n) yang mungkin hilang saat menyimpan private key
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Gunakan nama variabel kamu
  projectId: process.env.FIREBASE_PROJECT_ID, // Gunakan nama variabel kamu
};

// Validasi sederhana: Pastikan ketiga kredensial tersedia
if (!serviceAccount.clientEmail || !serviceAccount.privateKey || !serviceAccount.projectId) {
  console.error("Error: Satu atau lebih kredensial Firebase (FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_PROJECT_ID) tidak didefinisikan di environment variable!");
  process.exit(1); // Hentikan script dengan error
}

// Inisialisasi Firebase Admin SDK dengan kredensial tersebut
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://bygf-6f77-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const db = admin.database();
const messaging = admin.messaging();
// ── Waktu sekarang dalam zona Jakarta (UTC+7) ──
function getJakartaTime() {
  const now     = new Date();
  const jakarta = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return {
    hours:   jakarta.getUTCHours(),
    minutes: jakarta.getUTCMinutes(),
    timeStr: `${String(jakarta.getUTCHours()).padStart(2,'0')}:${String(jakarta.getUTCMinutes()).padStart(2,'0')}`,
    today:   jakarta.toISOString().split('T')[0],
    month:   jakarta.toISOString().substring(0, 7),
  };
}

// ── Format IDR singkat ──
function fmtIDR(num) {
  num = Math.abs(num);
  if (num >= 1_000_000) return `Rp ${(num / 1_000_000).toFixed(1)}jt`;
  if (num >= 1_000)     return `Rp ${(num / 1_000).toFixed(0)}rb`;
  return `Rp ${num}`;
}

// ── Kirim FCM push ke satu token ──
async function sendPush(token, title, body, tag, url = './') {
  try {
    await messaging.send({
      token,
      webpush: {
        notification: {
          title,
          body,
          icon:     'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
          badge:    'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
          tag,
          renotify: true,
          vibrate:  [200, 100, 200],
        },
        fcmOptions: { link: url }
      }
    });
    console.log(`✅ Sent [${tag}]: ${title}`);
    return true;
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      // Token expired — hapus dari DB
      console.log(`⚠️  Token expired, cleaning up...`);
      try {
        const snap = await db.ref('users').orderByChild('fcmToken').equalTo(token).once('value');
        const updates = {};
        snap.forEach(s => { updates[`users/${s.key}/fcmToken`] = null; });
        if (Object.keys(updates).length) await db.ref().update(updates);
      } catch(e) {}
    } else {
      console.error(`❌ Error [${tag}]: ${err.message}`);
    }
    return false;
  }
}

// ================================================================
// MAIN
// ================================================================
async function run() {
  const t = getJakartaTime();
  console.log(`\n🕐 Jakarta time: ${t.timeStr} | Date: ${t.today}`);

  // Ambil semua data user dari Firebase
  const usersSnap = await db.ref('users').once('value');
  if (!usersSnap.exists()) { console.log('No users found.'); return; }

  const jobs = [];

  usersSnap.forEach(userSnap => {
    const uid      = userSnap.key;
    const userData = userSnap.val() || {};
    const appData  = userData.appData || {};
    const settings = appData.settings || {};
    const token    = userData.fcmToken;
    const username = userData.profile?.displayName || userData.profile?.username || '';

    // Skip kalau tidak ada token atau user dummy
    if (!token || token === 'dummy' || uid === 'dummy_admin') return;

    const txRaw  = appData.transactions || [];
    const txList = Array.isArray(txRaw) ? txRaw : Object.values(txRaw);

    // ── 1. Evening Reminder ──────────────────────────────────────
    if (settings.reminderEnabled && settings.reminderTime === t.timeStr) {
      const hasToday = txList.some(tx => tx.tanggal === t.today);
      if (!hasToday) {
        const name = username ? `, ${username}` : '';
        jobs.push(sendPush(
          token,
          `💰 Waktunya Catat Keuangan${name}!`,
          'Kamu belum mencatat transaksi hari ini. Yuk catat pengeluaranmu sekarang!',
          'daily-reminder'
        ));
      } else {
        console.log(`ℹ️  [${uid.slice(0,6)}] Sudah ada transaksi hari ini, skip evening reminder.`);
      }
    }

    // ── 2. Morning Briefing ──────────────────────────────────────
    if (settings.morningEnabled && settings.morningTime === t.timeStr) {
      const txMonth = txList.filter(tx => (tx.tanggal || '').startsWith(t.month));
      const income  = txMonth.reduce((s, tx) => s + (tx.pemasukan  || 0), 0);
      const expense = txMonth.reduce((s, tx) => s + (tx.pengeluaran || 0), 0);
      const balance = income - expense;
      const sign    = balance >= 0 ? '+' : '-';
      const greeting = username ? `Selamat pagi, ${username}! ` : 'Selamat pagi! ';

      jobs.push(sendPush(
        token,
        '☀️ Ringkasan Keuangan Pagi Ini',
        `${greeting}Bulan ini — Masuk: ${fmtIDR(income)} · Keluar: ${fmtIDR(expense)} · Saldo: ${sign}${fmtIDR(Math.abs(balance))}`,
        'morning-briefing'
      ));
    }

    // ── 3. Budget Alert (cek tiap jam tepat, misal 10:00, 14:00, dst) ──
    if (settings.budgetAlertEnabled && t.minutes === 0) {
      const budgets  = appData.budgets || [];
      const budgList = Array.isArray(budgets) ? budgets : Object.values(budgets);
      const allCats  = [...(appData.customCategories || []),
                        {id:'lainnya',name:'Lainnya'}, {id:'jajan',name:'Jajan'},
                        {id:'shopping',name:'Shopping'}, {id:'sekolah',name:'Sekolah'},
                        {id:'gift',name:'Gift'}, {id:'uang_mingguan',name:'Uang Mingguan'}];

      budgList.forEach(b => {
        const spent   = txList
          .filter(tx => (tx.tanggal||'').startsWith(t.month) && tx.kategori === b.category)
          .reduce((s, tx) => s + (tx.pengeluaran || 0), 0);
        const pct     = b.amount > 0 ? (spent / b.amount) * 100 : 0;
        const catName = (allCats.find(c => c.id === b.category) || {name: b.category}).name;

        if (pct >= 100) {
          jobs.push(sendPush(
            token,
            '🚨 Budget Terlampaui!',
            `Pengeluaran "${catName}" sudah ${fmtIDR(spent)} — melewati limit ${fmtIDR(b.amount)}.`,
            `budget-over-${b.category}`
          ));
        } else if (pct >= 80) {
          jobs.push(sendPush(
            token,
            '⚠️ Budget Hampir Habis',
            `"${catName}" sudah ${Math.round(pct)}% dari limit. Sisa ${fmtIDR(b.amount - spent)}.`,
            `budget-warn-${b.category}`
          ));
        }
      });
    }

    // ── 4. Debt Due Date (cek tiap pagi jam 08:xx) ──────────────
    if (t.hours === 8) {
      const debts    = appData.debts || [];
      const debtList = Array.isArray(debts) ? debts : Object.values(debts);

      debtList.forEach(d => {
        if (!d.tanggal || !d.sisa) return;
        const due      = new Date(d.tanggal + 'T00:00:00Z');
        const todayD   = new Date(t.today + 'T00:00:00Z');
        const daysLeft = Math.round((due - todayD) / 86_400_000);

        if (daysLeft < 0) {
          jobs.push(sendPush(token,
            '🔴 Hutang Jatuh Tempo!',
            `Hutang ke "${d.nama}" sebesar ${fmtIDR(d.sisa)} sudah melewati tanggal jatuh tempo.`,
            `debt-overdue-${d.id}`
          ));
        } else if (daysLeft === 0) {
          jobs.push(sendPush(token,
            '⏰ Hutang Jatuh Tempo Hari Ini!',
            `Hutang ke "${d.nama}" sebesar ${fmtIDR(d.sisa)} jatuh tempo hari ini.`,
            `debt-today-${d.id}`
          ));
        } else if (daysLeft <= 3) {
          jobs.push(sendPush(token,
            '📅 Pengingat Hutang',
            `Hutang ke "${d.nama}" sebesar ${fmtIDR(d.sisa)} jatuh tempo ${daysLeft} hari lagi.`,
            `debt-soon-${d.id}`
          ));
        }
      });
    }

    // ── 5. Goals Celebration (cek tiap jam 09:xx) ────────────────
    if (t.hours === 9 && t.minutes < 5) {
      const goals    = appData.goals || [];
      const goalList = Array.isArray(goals) ? goals : Object.values(goals);

      goalList.forEach(g => {
        if (!g.target || !g.current) return;
        const pct = (g.current / g.target) * 100;

        if (pct >= 100) {
          jobs.push(sendPush(token,
            '🏆 Target Impian Tercapai!',
            `Selamat! Target "${g.name}" sebesar ${fmtIDR(g.target)} sudah terpenuhi!`,
            `goal-done-${g.id}`
          ));
        } else if (pct >= 80) {
          jobs.push(sendPush(token,
            '🎯 Hampir Sampai!',
            `Target "${g.name}" sudah ${Math.round(pct)}% terpenuhi. Yuk tambah tabungan!`,
            `goal-near-${g.id}`
          ));
        }
      });
    }
  });

  if (jobs.length === 0) {
    console.log('💤 No notifications to send this minute.');
    return;
  }

  const results = await Promise.allSettled(jobs);
  const ok  = results.filter(r => r.status === 'fulfilled' && r.value).length;
  const err = results.length - ok;
  console.log(`\n📊 Done: ${ok} sent, ${err} failed.`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
