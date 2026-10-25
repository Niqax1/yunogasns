// 画面の切り替え（URL を変えて、登録された処理で表示し直す）

let routeHandler = () => {};

export function onRoute(handler) {
  routeHandler = handler;
}

export function navigate(path, options = {}) {
  if (path !== location.pathname) history.pushState({ inApp: true }, "", path);
  routeHandler(options);
}
