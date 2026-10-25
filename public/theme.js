// ページが描画される前に読み込まれ、保存済みのテーマ（なければ端末の設定）を適用する。
// 切り替えボタンなどの処理は app.js にある。
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem("yunogasns:theme");
  } catch {
    // ストレージが使えない環境では端末の設定に従う
  }
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
})();
