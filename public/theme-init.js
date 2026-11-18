/* ============================================================
 * 主题预置
 * ------------------------------------------------------------
 * 必须在样式表之前同步执行：否则刷新时会先渲染浅色再变深色（FOUC）。
 * 独立成文件是为了让页面可以启用「禁止内联脚本」的严格 CSP。
 * ============================================================ */

(function () {
  try {
    var saved = localStorage.getItem('bili-theme');
    if (saved !== 'dark' && saved !== 'light') {
      saved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
