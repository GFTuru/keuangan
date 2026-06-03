// ================================================================
// firebase-messaging-sw.js — Keuangan Pro Service Worker
// Versi: 2.0 (Smart Notification Engine)
// ================================================================

const SW_VERSION = '2.0.0';

// ── State internal SW ──
let state = {
  reminderEnabled:    false,
  reminderTime:       '20:00',
  morningEnabled:     false,
  morningTime:        '08:00',
  budgetAlertEnabled: false,
  hasTransactionToday: false,
  username:           '',
  budgets:            [],
  transactions:       [],
  categories:         [],
  debts:              [],
  paylaters:          [],
  goals:              [],
};

// ── Timeout handles ──
let timeouts = {
  evening:    null,
  morning:    null,
  budgetCheck: null,
  dueCheck:   null,
};

// ── Cooldown: cegah notif spam ──
// key = notif ID, value = last sent timestamp
const notifCooldown = {};
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 jam

function canNotify(id) {
  const last = notifCooldown[id] || 0;
  if (Date.now() - last > COOLDOWN_MS) { notifCooldown[id] = Date.now(); return true; }
  return false;
}

// ================================================================
// LIFECYCLE
// ================================================================
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// ================================================================
// MESSAGE HANDLER — menerima perintah dari halaman utama
// ================================================================
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  switch (type) {

    // Full state sync — dikirim setelah login / ubah settings
    case 'SYNC_STATE':
      Object.assign(state, payload);
      rescheduleAll();
      break;

    // Cek budget setelah tambah transaksi
    case 'CHECK_BUDGET':
      Object.assign(state, {
        budgets:      event.data.budgets      || state.budgets,
        transactions: event.data.transactions || state.transactions,
        categories:   event.data.categories   || state.categories,
      });
      if (state.budgetAlertEnabled) checkBudgets();
      break;

    // Cek jatuh tempo hutang / paylater
    case 'CHECK_DUE':
      Object.assign(state, {
        debts:     event.data.debts     || state.debts,
        paylaters: event.data.paylaters || state.paylaters,
      });
      checkDueDates();
      break;

    // Cek goals progress
    case 'CHECK_GOALS':
      state.goals = event.data.goals || state.goals;
      checkGoals();
      break;

    // Test notifikasi dari settings
    case 'TEST_NOTIFICATION':
      sendNotif('test', {
        title: '🔔 Keuangan Pro — Test Berhasil!',
        body:  'Notifikasi aktif dan berfungsi dengan baik ✅',
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        tag:   'test',
        data:  { url: './' },
      }, /* forceSkipCooldown= */ true);
      break;

    // Backward compat dengan versi lama
    case 'SCHEDULE_REMINDER':
      state.reminderEnabled        = true;
      state.reminderTime           = event.data.time || '20:00';
      state.hasTransactionToday    = event.data.hasTransactionToday || false;
      scheduleEvening();
      break;
  }
});

// Notifikasi diklik → buka/fokus ke app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// ================================================================
// RESCHEDULE ALL — dipanggil setiap kali state berubah
// ================================================================
function rescheduleAll() {
  scheduleEvening();
  scheduleMorning();
  scheduleBudgetCheck();
  scheduleDueCheck();
}

// ================================================================
// 1. EVENING REMINDER — ingatkan catat transaksi
// ================================================================
function scheduleEvening() {
  if (timeouts.evening) { clearTimeout(timeouts.evening); timeouts.evening = null; }
  if (!state.reminderEnabled) return;
  if (state.hasTransactionToday) return; // Sudah catat hari ini, skip

  const delay = msUntilTime(state.reminderTime || '20:00');
  timeouts.evening = setTimeout(() => {
    // Re-check apakah sudah ada transaksi saat notif tiba
    if (!state.hasTransactionToday) {
      const name = state.username ? `, ${state.username}` : '';
      sendNotif('evening', {
        title: `💰 Waktunya Catat Keuangan${name}!`,
        body:  'Kamu belum mencatat transaksi hari ini. Yuk catat pengeluaranmu sekarang!',
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        image: notifImgUrl('evening', `💰 Waktunya Catat Keuangan${name}!`, 'Belum ada transaksi hari ini — yuk catat sekarang!'),
        tag:   'daily-reminder',
        renotify: true,
        vibrate:  [200, 100, 200],
        actions:  [{ action: 'open', title: '📝 Catat Sekarang' }, { action: 'dismiss', title: 'Nanti Saja' }],
        data:     { url: './' },
      });
    }
    // Jadwalkan ulang untuk besok
    timeouts.evening = setTimeout(() => scheduleEvening(), 24 * 60 * 60 * 1000);
  }, delay);
}

// ================================================================
// 2. MORNING BRIEFING — ringkasan keuangan bulan berjalan
// ================================================================
function scheduleMorning() {
  if (timeouts.morning) { clearTimeout(timeouts.morning); timeouts.morning = null; }
  if (!state.morningEnabled) return;

  const delay = msUntilTime(state.morningTime || '08:00');
  timeouts.morning = setTimeout(() => {
    const now      = new Date();
    const monthStr = now.toISOString().substring(0, 7);
    const txMonth  = state.transactions.filter(t => (t.tanggal || '').startsWith(monthStr));
    const income   = txMonth.reduce((s, t) => s + (t.pemasukan || 0), 0);
    const expense  = txMonth.reduce((s, t) => s + (t.pengeluaran || 0), 0);
    const balance  = income - expense;
    const sign     = balance >= 0 ? '+' : '';
    const name     = state.username ? `Selamat pagi, ${state.username}! ` : 'Selamat pagi! ';

    sendNotif('morning', {
      title: '☀️ Ringkasan Keuangan Pagi Ini',
      body:  `${name}Bulan ini: Pemasukan ${fmtIDR(income)} · Pengeluaran ${fmtIDR(expense)} · Saldo ${sign}${fmtIDR(balance)}`,
      icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
      badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
      image: notifImgUrl('morning', `${name}☀️ Ringkasan Bulan Ini`, `Masuk ${fmtIDR(income)} · Keluar ${fmtIDR(expense)} · Saldo ${sign}${fmtIDR(balance)}`),
      tag:   'morning-briefing',
      renotify: true,
      data:  { url: './' },
    });

    // Jadwalkan ulang besok
    timeouts.morning = setTimeout(() => scheduleMorning(), 24 * 60 * 60 * 1000);
  }, delay);
}

// ================================================================
// 3. BUDGET ALERT — warning saat pengeluaran mendekati / melewati limit
// ================================================================
function scheduleBudgetCheck() {
  if (timeouts.budgetCheck) { clearTimeout(timeouts.budgetCheck); timeouts.budgetCheck = null; }
  if (!state.budgetAlertEnabled) return;

  // Cek setiap 2 jam
  checkBudgets();
  timeouts.budgetCheck = setInterval(() => checkBudgets(), 2 * 60 * 60 * 1000);
}

function checkBudgets() {
  if (!state.budgets.length) return;
  const monthStr = new Date().toISOString().substring(0, 7);

  state.budgets.forEach(b => {
    const spent = state.transactions
      .filter(t => (t.tanggal || '').startsWith(monthStr) && t.kategori === b.category)
      .reduce((s, t) => s + (t.pengeluaran || 0), 0);

    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    const catName = (state.categories.find(c => c.id === b.category) || { name: b.category }).name;

    if (pct >= 100 && canNotify(`budget-over-${b.category}`)) {
      sendNotif(`budget-over-${b.category}`, {
        title: '🚨 Budget Terlampaui!',
        body:  `Pengeluaran "${catName}" sudah ${fmtIDR(spent)} — melewati limit ${fmtIDR(b.amount)}.`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        image: notifImgUrl('budget_over', `🚨 Budget ${catName} Terlampaui!`, `${fmtIDR(spent)} dari limit ${fmtIDR(b.amount)}`, Math.min(Math.round(pct), 100)),
        tag:   `budget-${b.category}`, renotify: true,
        data:  { url: './' },
      });
    } else if (pct >= 80 && pct < 100 && canNotify(`budget-warn-${b.category}`)) {
      sendNotif(`budget-warn-${b.category}`, {
        title: '⚠️ Budget Hampir Habis',
        body:  `"${catName}" sudah ${Math.round(pct)}% dari limit. Sisa ${fmtIDR(b.amount - spent)}.`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        image: notifImgUrl('budget_warn', `⚠️ Budget ${catName} Hampir Habis`, `Sisa ${fmtIDR(b.amount - spent)} dari limit ${fmtIDR(b.amount)}`, Math.round(pct)),
        tag:   `budget-${b.category}`, renotify: true,
        data:  { url: './' },
      });
    }
  });
}

// ================================================================
// 4. DUE DATE REMINDER — hutang / paylater jatuh tempo
// ================================================================
function scheduleDueCheck() {
  if (timeouts.dueCheck) { clearTimeout(timeouts.dueCheck); timeouts.dueCheck = null; }
  // Cek setiap 6 jam
  checkDueDates();
  timeouts.dueCheck = setInterval(() => checkDueDates(), 6 * 60 * 60 * 1000);
}

function checkDueDates() {
  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const in3days  = new Date(today); in3days.setDate(today.getDate() + 3);
  const in7days  = new Date(today); in7days.setDate(today.getDate() + 7);

  // Cek paylater (tidak ada due date, jadi tidak relevan — skip)
  // Cek debts yang punya tanggal
  (state.debts || []).forEach(d => {
    if (!d.tanggal || !d.sisa) return;
    const due = new Date(d.tanggal + 'T00:00:00');
    const daysLeft = Math.round((due - today) / 86400000);

    if (daysLeft < 0 && canNotify(`debt-overdue-${d.id}`)) {
      sendNotif(`debt-overdue-${d.id}`, {
        title: '🔴 Hutang Jatuh Tempo!',
        body:  `Hutang ke "${d.nama}" sebesar ${fmtIDR(d.sisa)} sudah melewati tanggal jatuh tempo.`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', tag: `debt-${d.id}`, renotify: true,
        data:  { url: './' },
      });
    } else if (daysLeft === 0 && canNotify(`debt-today-${d.id}`)) {
      sendNotif(`debt-today-${d.id}`, {
        title: '⏰ Hutang Jatuh Tempo Hari Ini!',
        body:  `Hutang ke "${d.nama}" sebesar ${fmtIDR(d.sisa)} jatuh tempo hari ini.`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', tag: `debt-${d.id}`, renotify: true,
        data:  { url: './' },
      });
    } else if (daysLeft <= 3 && daysLeft > 0 && canNotify(`debt-soon-${d.id}`)) {
      sendNotif(`debt-soon-${d.id}`, {
        title: '📅 Pengingat Hutang',
        body:  `Hutang ke "${d.nama}" sebesar ${fmtIDR(d.sisa)} jatuh tempo ${daysLeft} hari lagi.`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', tag: `debt-${d.id}`, renotify: true,
        data:  { url: './' },
      });
    }
  });
}

// ================================================================
// 5. GOALS CELEBRATION — ketika target hampir / sudah tercapai
// ================================================================
function checkGoals() {
  (state.goals || []).forEach(g => {
    if (!g.target || !g.current) return;
    const pct = (g.current / g.target) * 100;

    if (pct >= 100 && canNotify(`goal-done-${g.id}`)) {
      sendNotif(`goal-done-${g.id}`, {
        title: '🏆 Target Impian Tercapai!',
        body:  `Selamat! Target "${g.name}" sebesar ${fmtIDR(g.target)} sudah terpenuhi!`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        image: notifImgUrl('goal_done', `🏆 Target "${g.name}" LUNAS!`, `Total ${fmtIDR(g.target)} berhasil terkumpul 🎉`, 100),
        tag: `goal-${g.id}`, renotify: true,
        data:  { url: './' },
      });
    } else if (pct >= 80 && pct < 100 && canNotify(`goal-near-${g.id}`)) {
      sendNotif(`goal-near-${g.id}`, {
        title: '🎯 Hampir Sampai!',
        body:  `Target "${g.name}" sudah ${Math.round(pct)}% terpenuhi. Yuk tambah tabungan!`,
        icon:  'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png', badge: 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
        image: notifImgUrl('goal_near', `🎯 Target "${g.name}" ${Math.round(pct)}%`, `Terkumpul ${fmtIDR(g.current)} dari ${fmtIDR(g.target)}`, Math.round(pct)),
        tag: `goal-${g.id}`, renotify: true,
        data:  { url: './' },
      });
    }
  });
}

// ================================================================
// HELPER: kirim notifikasi via SW registration
// ================================================================
function sendNotif(id, options, forceSkipCooldown = false) {
  if (!forceSkipCooldown && !canNotify(id)) return;
  self.registration.showNotification(options.title, {
    body:             options.body || '',
    icon:             options.icon || 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
    badge:            options.badge || 'https://i.ibb.co.com/0RGKc1CF/only-logo-192.png',
    tag:              options.tag || id,
    renotify:         options.renotify || false,
    requireInteraction: false,
    vibrate:          options.vibrate || [150, 75, 150],
    actions:          options.actions || [],
    data:             options.data || { url: './' },
  }).catch(() => {}); // Abaikan jika permission hilang
}

// ================================================================
// HELPER: hitung ms hingga waktu HH:MM berikutnya
// ================================================================
function msUntilTime(timeStr) {
  const [h, m]   = (timeStr || '20:00').split(':').map(Number);
  const now      = new Date();
  const target   = new Date();
  target.setHours(h, m, 0, 0);
  if (now >= target) target.setDate(target.getDate() + 1); // Jadwalkan besok jika sudah lewat
  return target.getTime() - now.getTime();
}

// ================================================================
// HELPER: format IDR singkat (tanpa desimal)
// ================================================================
function fmtIDR(num) {
  if (num >= 1_000_000) return `Rp ${(num / 1_000_000).toFixed(1)}jt`;
  if (num >= 1_000)     return `Rp ${(num / 1_000).toFixed(0)}rb`;
  return `Rp ${num}`;
}

// ================================================================
// NOTIFICATION IMAGE GENERATOR — via OffscreenCanvas
// Intercept requests ke /~kp-notif/?type=X untuk generate PNG
// ================================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes('~kp-notif')) return;
  const type   = url.searchParams.get('t') || 'default';
  const line1  = decodeURIComponent(url.searchParams.get('l1') || '');
  const line2  = decodeURIComponent(url.searchParams.get('l2') || '');
  const pct    = parseInt(url.searchParams.get('pct') || '0');
  event.respondWith(generateNotifImage(type, line1, line2, pct));
});

async function generateNotifImage(type, line1, line2, pct) {
  const W = 480, H = 120;
  const canvas = new OffscreenCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // ── Pilih palet warna per tipe ──
  const palettes = {
    evening:      ['#1e1b4b', '#312e81', '#6366f1'],  // Indigo
    morning:      ['#064e3b', '#065f46', '#10b981'],  // Emerald
    budget_warn:  ['#78350f', '#92400e', '#f59e0b'],  // Amber
    budget_over:  ['#7f1d1d', '#991b1b', '#ef4444'],  // Red
    debt_due:     ['#7c2d12', '#9a3412', '#f97316'],  // Orange
    goal_near:    ['#1e3a5f', '#1e40af', '#3b82f6'],  // Blue
    goal_done:    ['#14532d', '#166534', '#22c55e'],  // Green
    default:      ['#1e1b4b', '#312e81', '#818cf8'],  // Default indigo
  };
  const [c1, c2, accent] = palettes[type] || palettes.default;

  // ── Background gradient ──
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ── Subtle pattern overlay ──
  ctx.globalAlpha = 0.04;
  for(let i = 0; i < W; i += 20) {
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - H, H); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ── Accent side bar ──
  const barGrad = ctx.createLinearGradient(0, 0, 0, H);
  barGrad.addColorStop(0, accent);
  barGrad.addColorStop(1, accent + '44');
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, 0, 5, H);

  // ── App label ──
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillText('KEUANGAN PRO', W - 110, 16);

  // ── Line 1 (main text) ──
  ctx.fillStyle = 'white';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText(truncate(line1, 36), 20, 44);

  // ── Line 2 (sub text) ──
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(truncate(line2, 52), 20, 66);

  // ── Progress bar (kalau ada pct) ──
  if(pct > 0) {
    const barY = 85, barH = 8, barX = 20, barW = W - 40;
    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();
    // Fill
    const fillW = Math.min((pct / 100) * barW, barW);
    const fillGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    fillGrad.addColorStop(0, accent);
    fillGrad.addColorStop(1, accent + 'cc');
    ctx.fillStyle = fillGrad;
    roundRect(ctx, barX, barY, fillW, barH, 4);
    ctx.fill();
    // Label pct
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillText(`${pct}%`, barX + fillW + 6, barY + 8);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Response(blob, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }
  });
}

function truncate(str, max) {
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Helper buat URL gambar notif
function notifImgUrl(type, l1, l2, pct) {
  const base = self.registration.scope + '~kp-notif/';
  return `${base}?t=${type}&l1=${encodeURIComponent(l1||'')}&l2=${encodeURIComponent(l2||'')}&pct=${pct||0}`;
}
