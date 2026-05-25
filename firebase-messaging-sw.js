// firebase-messaging-sw.js
// Service Worker untuk reminder transaksi dengan jam Dinamis

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

let reminderTimeout = null;

// Terima pesan dari halaman utama
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
    scheduleReminder(event.data.time, event.data.hasTransactionToday);
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
function scheduleReminder(timeString, hasTransactionToday) {
  // Jika sudah ada transaksi hari ini, tidak perlu dikirim notifikasinya
  if (hasTransactionToday) return;

  // Bersihkan timeout lama jika ada
  if (reminderTimeout) clearTimeout(reminderTimeout);

  const now = new Date();
  const target = new Date();
  
  // Ambil jam dan menit dari format HH:MM (contoh 20:00)
  if (timeString) {
      const parts = timeString.split(':');
      target.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
  } else {
      target.setHours(20, 0, 0, 0); // Default jam 8 malam
  }

  // Kalau jam di pengaturan sudah kelewat di hari ini, jadwalkan buat besoknya
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target.getTime() - now.getTime();

  // Jadwalkan Notifikasi
  reminderTimeout = setTimeout(() => {
    self.registration.showNotification('💰 Waktunya Catat Keuangan!', {
      body: 'Kamu belum mencatat transaksi hari ini. Yuk catat pengeluaranmu sekarang!',
      icon: './logo.jpg', 
      badge: './logo.jpg',
      tag: 'daily-reminder',
      renotify: true,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { url: './' }
    });
  }, delay);
}
