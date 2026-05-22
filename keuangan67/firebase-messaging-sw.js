// firebase-messaging-sw.js
// Service Worker untuk reminder transaksi jam 20:00

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Terima pesan dari halaman utama
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
    scheduleReminder(event.data.hasTransactionToday);
  }
  if (event.data && event.data.type === 'CANCEL_REMINDER') {
    // Reset alarm jika user mau cancel (tidak dipakai tapi disiapkan)
  }
});

// Handle notifikasi diklik
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
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

// Fungsi schedule reminder
function scheduleReminder(hasTransactionToday) {
  // Jika sudah ada transaksi hari ini, tidak perlu reminder
  if (hasTransactionToday) return;

  const now = new Date();
  const target = new Date();
  target.setHours(20, 0, 0, 0);

  // Kalau sudah lewat jam 20:00, jadwalkan besok
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target.getTime() - now.getTime();

  // Simpan timer id di indexedDB agar persist
  setTimeout(() => {
    self.registration.showNotification('💰 Catat Keuangan Hari Ini!', {
      body: 'Kamu belum mencatat transaksi hari ini. Yuk catat sekarang!',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'daily-reminder',
      renotify: true,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { url: './' }
    });
  }, delay);
}
