/* 外观：深色 / 浅色 / 跟随系统。
 *
 * 首屏由 <head> 里的内联脚本先设好 data-theme，避免刷新时闪一下；
 * 这里负责切换按钮、跟随系统变化、以及把 <meta name="theme-color"> 同步过去。
 * 想从别处改主题：window.JarvisTheme.set('light' | 'dark' | 'auto')。
 */

const STORAGE_KEY = 'jarvis.theme';
const MODES = ['dark', 'light', 'auto'];
const LABELS = { dark: '深色', light: '浅色', auto: '跟随系统' };
const THEME_COLOR = { dark: '#080b0f', light: '#f1f4f7' };
const ICONS = {
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.9A8.6 8.6 0 1 1 11.1 3a7 7 0 0 0 9.9 9.9Z"/></svg>',
    light:
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/>' +
        '<path d="M11 1h2v3.2h-2zm0 18.8h2V23h-2zM1 11h3.2v2H1zm18.8 0H23v2h-3.2zM4.1 5.5l1.5-1.5 2.2 2.3-1.5 1.4zm12.2 12.3 1.4-1.5 2.3 2.3-1.5 1.4zM17.7 3.9l2.3 2.3-1.5 1.4-2.2-2.3zM3.9 17.7l1.4 1.4-2.3 2.3-1.4-1.5z"/></svg>',
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18V3Z"/></svg>',
};

const root = document.documentElement;
const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

function readStoredMode() {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        if (MODES.includes(value)) return value;
    } catch {
        /* 隐私模式下读不到就用默认值 */
    }
    return 'dark';
}

function resolveTheme(mode, systemLight = media?.matches) {
    if (mode === 'auto') return systemLight ? 'light' : 'dark';
    return mode;
}

function apply(mode, { persist = true, systemLight } = {}) {
    const safeMode = MODES.includes(mode) ? mode : 'dark';
    const theme = resolveTheme(safeMode, systemLight);

    root.dataset.themeMode = safeMode;
    root.dataset.theme = theme;

    if (persist) {
        try {
            localStorage.setItem(STORAGE_KEY, safeMode);
        } catch {
            /* 存不下也不影响这次切换 */
        }
    }

    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        meta.setAttribute('content', THEME_COLOR[theme]);
    }

    const button = document.getElementById('theme-btn');
    if (button) {
        button.innerHTML = ICONS[safeMode];
        button.dataset.mode = safeMode;
        button.title = `外观：${LABELS[safeMode]}（点击切换）`;
        button.setAttribute('aria-label', `外观：${LABELS[safeMode]}，点击切换`);
    }
}

window.JarvisTheme = {
    get mode() {
        return root.dataset.themeMode || readStoredMode();
    },
    get theme() {
        return root.dataset.theme || resolveTheme(this.mode);
    },
    set(mode) {
        apply(mode);
    },
    cycle() {
        const next = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
        apply(next);
    },
};

apply(readStoredMode(), { persist: false });

document.getElementById('theme-btn')?.addEventListener('click', () => window.JarvisTheme.cycle());

let lastSystemLight = media?.matches ?? false;

function syncSystemTheme() {
    if (readStoredMode() !== 'auto' || !media) return;
    const systemLight = media.matches;
    if (systemLight === lastSystemLight && root.dataset.theme === (systemLight ? 'light' : 'dark')) return;
    lastSystemLight = systemLight;
    apply('auto', { persist: false, systemLight });
}

function handleSystemThemeChange(event) {
    if (readStoredMode() !== 'auto') return;
    lastSystemLight = event.matches;
    apply('auto', { persist: false, systemLight: event.matches });
}

if (media) {
    if (typeof media.addEventListener === 'function') media.addEventListener('change', handleSystemThemeChange);
    else if (typeof media.addListener === 'function') media.addListener(handleSystemThemeChange);
    window.addEventListener('focus', syncSystemTheme);
    window.setInterval(syncSystemTheme, 250);
}