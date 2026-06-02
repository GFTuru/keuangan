// firebase-messaging-sw.js
// Service Worker untuk reminder transaksi PWA

let reminderTimeout = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Terima pesan dari halaman utama HTML
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
    // Jalankan reminder dengan data jam dinamis dari user
    scheduleReminder(event.data.time, event.data.hasTransactionToday);
  }
  
  if (event.data && event.data.type === 'CANCEL_REMINDER') {
    // Matikan alarm jika user mendisable toggle di pengaturan
    if (reminderTimeout) {
      clearTimeout(reminderTimeout);
      reminderTimeout = null;
    }
  }
});

// Handle notifikasi saat diklik
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Jika user menekan tombol "Nanti Saja", abaikan
  if (event.action === 'close') {
    return;
  }

  // Buka atau arahkan ulang ke aplikasi jika ditekan / klik "Catat Sekarang"
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});

// Fungsi schedule reminder cerdas
function scheduleReminder(timeStr, hasTransactionToday) {
  // Clear jadwal sebelumnya agar tidak tumpang tindih
  if (reminderTimeout) {
    clearTimeout(reminderTimeout);
  }

  // Jika sudah ada transaksi hari ini, tidak perlu di-remind lagi
  if (hasTransactionToday) return;

  const now = new Date();
  const target = new Date();
  
  // Parse waktu dari user (format "HH:MM")
  if (timeStr) {
      const [hours, minutes] = timeStr.split(':');
      target.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
  } else {
      target.setHours(20, 0, 0, 0); // Fallback bawaan jam 8 malam
  }

  // Kalau sudah lewat jam yang disetel, jadwalkan untuk besok harinya
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target.getTime() - now.getTime();

  // Jadwalkan notifikasi menggunakan timeout PWA
  reminderTimeout = setTimeout(() => {
    self.registration.showNotification('💰 Waktunya Catat Keuangan!', {
      body: 'Kamu belum mencatat transaksi pengeluaran atau pemasukan hari ini. Yuk catat sekarang agar keuanganmu tetap rapi!',
      icon: './logo.jpg',
      badge: './logo.jpg',
      tag: 'daily-reminder',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200],
      actions: [
        { action: 'open_app', title: 'Catat Sekarang ✍️' },
        { action: 'close', title: 'Nanti Saja ❌' }
      ],
      data: { url: './' }
    });
  }, delay);
}
