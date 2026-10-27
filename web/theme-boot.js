/* 首屏主题引导：在样式表之前同步执行，避免刷新时先画深色再跳浅色。
 * 单独成文件是因为页面有 CSP（script-src 'self'），内联脚本会被拦掉。
 * 判定逻辑与 /theme.js 保持一致。 */
(function () {
    var root = document.documentElement;
    var mode = 'dark';
    try {
        var saved = localStorage.getItem('jarvis.theme');
        if (saved === 'light' || saved === 'dark' || saved === 'auto') mode = saved;
    } catch (error) {
        /* 读不到就用默认深色 */
    }
    var light =
        mode === 'light' ||
        (mode === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    root.setAttribute('data-theme', light ? 'light' : 'dark');
    root.setAttribute('data-theme-mode', mode);
    if (light) {
        var metas = document.querySelectorAll('meta[name="theme-color"]');
        for (var i = 0; i < metas.length; i += 1) metas[i].setAttribute('content', '#f1f4f7');
    }
})();