// 通知（Web Push）を受け取って表示する Service Worker。
// アプリを閉じていても、サーバーから届いた通知を端末に出す。画面のファイルのキャッシュなどはしない。

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data?.json() ?? {};
  } catch {
    message = { body: event.data?.text() ?? "" };
  }
  event.waitUntil(
    self.registration.showNotification(message.title || "Yunoga SNS", {
      body: message.body || "",
      icon: "/icons/icon-192.png",
      tag: message.tag,
      data: { url: appPath(message.url) },
    }),
  );
});

// 通知を押したときに開く画面。このアプリの中のURLだけにする（"//example.com" のような別のサイトは開かない）
function appPath(url) {
  if (typeof url !== "string") return "/";
  try {
    const target = new URL(url, self.location.origin);
    if (target.origin === self.location.origin) return target.pathname;
  } catch {}
  return "/";
}

// 通知を押したら、アプリを開いて（開いていれば前に出して）その画面へ移る
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url ?? "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((window) => new URL(window.url).origin === self.location.origin);
      if (client) {
        await client.focus();
        client.postMessage({ type: "open", path });
      } else {
        await self.clients.openWindow(path);
      }
    })(),
  );
});
