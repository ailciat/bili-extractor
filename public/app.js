/* ============================================================
   提炼 · 前端逻辑
   模式：video / audio / cover
   视图：单条详情 / 批量列表，由解析条数自动决定
   ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  mode: 'video',
  items: [],          // [{ input, info, ok, error, selected }]
  activeIdx: 0,       // 详情视图当前条目
  pageIndex: 0,       // 当前分 P 下标（清晰度以此为准）
  selectedPages: new Set(), // 勾选待下载的分集下标
  qualities: [],      // 当前分 P 的清晰度 / 音质列表
  batchQualities: [],
  busy: false,

  demo: false,        // 在线演示模式：开放受控下载，不登录、不写设置

  loginKey: null,
  loginTimer: null,
  loginState: 'idle', // idle | loading | waiting | scanned | ok | expired

  taskTimer: null,
  lastTaskSig: '',
  account: null,

  downloadDir: '', // 设置里正在编辑的保存位置
};

const MODE_META = {
  video: { hint: '输出 MP4 · 含音轨', label: '清晰度', action: '下载视频', batchLabel: '清晰度' },
  audio: { hint: '输出 M4A · 纯音频', label: '音质', action: '下载音频', batchLabel: '音质' },
  cover: { hint: '输出 JPG · 原图尺寸', label: '', action: '下载封面', batchLabel: '' },
};

/* ============================================================
   工具
   ============================================================ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ============================================================
   目录选择
   ============================================================ */

const dirState = { path: '', parent: '' };

const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5a2 2 0 0 1 2-2h3.7l2 2.4H19a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

async function openDirPicker() {
  $('dirMask').classList.add('show');
  $('dirList').innerHTML = '<li class="dir-empty">读取中…</li>';

  try {
    const d = await api('/api/fs/roots');

    const shortcuts = [
      ...(d.shortcuts || []).map((x) => ({ ...x, kind: 'shortcut' })),
      ...(d.roots || []).map((x) => ({ ...x, kind: 'root' })),
    ];

    $('dirShortcuts').innerHTML = shortcuts
      .map(
        (x) =>
          `<button class="dir-shortcut" data-path="${esc(x.path)}">${esc(x.name)}</button>`
      )
      .join('');

    $('dirShortcuts')
      .querySelectorAll('.dir-shortcut')
      .forEach((b) => b.addEventListener('click', () => loadDir(b.dataset.path)));

    // 从当前保存位置开始；不可用则退回用户目录
    await loadDir(state.downloadDir || d.home);
  } catch (e) {
    $('dirList').innerHTML = `<li class="dir-empty">${esc(e.message)}</li>`;
  }
}

async function loadDir(target) {
  try {
    const d = await api('/api/fs/list?path=' + encodeURIComponent(target));
    dirState.path = d.path;
    dirState.parent = d.parent || '';

    $('dirPath').textContent = d.path;
    $('dirPath').title = d.path;
    $('btnDirUp').disabled = !d.parent;

    if (!d.dirs || !d.dirs.length) {
      $('dirList').innerHTML = '<li class="dir-empty">这里没有子文件夹</li>';
      return;
    }

    $('dirList').innerHTML = d.dirs
      .map(
        (x) => `
        <li>
          <button class="dir-item" data-path="${esc(x.path)}">
            <span class="ico">${FOLDER_ICON}</span>
            <span>${esc(x.name)}</span>
          </button>
        </li>`
      )
      .join('');

    $('dirList')
      .querySelectorAll('.dir-item')
      .forEach((b) => b.addEventListener('click', () => loadDir(b.dataset.path)));
  } catch (e) {
    $('dirList').innerHTML = `<li class="dir-empty">${esc(e.message)}</li>`;
  }
}

function chooseDir() {
  if (!dirState.path) return;
  state.downloadDir = dirState.path;
  $('dirValue').textContent = dirState.path;
  $('dirMask').classList.remove('show');
}

/* ============================================================
   主题（深 / 浅）
   ============================================================ */

const THEME_KEY = 'bili-theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'dark'
    : 'light';
}

function setTheme(theme, remember = true) {
  // 切换瞬间挂上过渡类，避免整页颜色硬跳
  document.documentElement.classList.add('theme-switching');
  document.documentElement.setAttribute('data-theme', theme);

  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  }

  setTimeout(
    () => document.documentElement.classList.remove('theme-switching'),
    280
  );
}

function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** 用户没有手动选过时，跟随系统深色偏好变化 */
function watchSystemTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (e) => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* ignore */
    }
    if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
  };

  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ============================================================
   图片骨架屏
   ============================================================ */

/** 给图片挂上 shimmer 占位，加载完成或失败后移除 */
function bindImgSkeleton(img) {
  if (!img) return;

  img.classList.remove('is-broken');
  img.classList.add('is-loading');

  const done = () => img.classList.remove('is-loading');
  const fail = () => {
    img.classList.remove('is-loading');
    img.classList.add('is-broken');
  };

  // 命中缓存时 complete 已为 true，不会再触发 load 事件
  if (img.complete) {
    if (img.naturalWidth > 0) done();
    else fail();
    return;
  }

  img.addEventListener('load', done, { once: true });
  img.addEventListener('error', fail, { once: true });
}

/* ============================================================
   滚动进场
   ============================================================ */

const revealObserver =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              e.target.classList.add('in');
              revealObserver.unobserve(e.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
      )
    : null;

/** 元素滚入视口时淡入；delay 用于让列表项依次出现 */
function watchFadeUp(el, delay = 0) {
  if (!el) return;

  el.classList.remove('in');
  el.classList.add('fade-up');
  el.style.transitionDelay = delay ? `${delay}ms` : '';

  if (!revealObserver) {
    el.classList.add('in');
    return;
  }

  // 已经在视口里就直接显示：观察器回调是异步的，
  // 元素若在 observe 之后才从 display:none 变为可见，可能错过首帧。
  // 用 setTimeout 而不是 rAF —— 后台标签页的 rAF 会被节流。
  const rect = el.getBoundingClientRect();
  if (rect.bottom > 0 && rect.top < window.innerHeight) {
    setTimeout(() => el.classList.add('in'), 30);
    return;
  }

  revealObserver.observe(el);
}

/* ============================================================
   提示条
   ============================================================ */

let noticeTimer = null;

function notice(text, type = 'info', ms = 0) {
  const el = $('notice');
  el.dataset.type = type;
  el.classList.add('show');
  $('noticeText').textContent = text;
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function clearNotice() {
  $('notice').classList.remove('show');
}

/* ============================================================
   请求
   ============================================================ */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error('本地服务没有响应，请确认程序窗口还在运行');
  }
  if (!j.ok) throw new Error(j.error || '请求失败');
  return j.data;
}

/* ============================================================
   输入区
   ============================================================ */

function splitInput() {
  return [...new Set(
    $('input').value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  )];
}

/* ============================================================
   最近解析 & 画质偏好（都存在本机 localStorage）
   ============================================================ */

const RECENT_KEY = 'bili-recent';
const PREF_KEY = 'bili-pref';

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function shortTitle(s, n = 16) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 解析成功后记一笔，方便下次一键回填 */
function pushRecent(input, title) {
  if (!input) return;

  let list = loadRecent().filter((x) => x.input !== input);
  list.unshift({ input, title: title || input, ts: Date.now() });
  list = list.slice(0, 10);

  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式忽略 */
  }
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  const row = $('recentRow');
  const box = $('recentList');
  if (!row || !box) return;

  if (!list.length) {
    row.hidden = true;
    return;
  }

  row.hidden = false;
  box.innerHTML = list
    .slice(0, 5)
    .map(
      (x, i) =>
        `<button class="recent-chip" data-i="${i}" title="${esc(x.input)}">${esc(
          shortTitle(x.title)
        )}</button>`
    )
    .join('');

  box.querySelectorAll('.recent-chip').forEach((b) => {
    b.addEventListener('click', () => {
      const item = list[Number(b.dataset.i)];
      if (!item) return;
      $('input').value = item.input;
      updateInputCount();
      autoGrow();
      doParse();
    });
  });
}

function loadPref() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePref(patch) {
  const next = { ...loadPref(), ...patch };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function updateInputCount() {
  const n = splitInput().length;
  $('inputCount').textContent = `${n} 行`;
  $('btnClearInput').hidden = !$('input').value.trim();
}

/** 输入框随内容增高：96px 起，260px 封顶 */
function autoGrow() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(240, Math.max(78, el.scrollHeight)) + 'px';
}

/* ============================================================
   模式切换
   ============================================================ */

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;

  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  });

  const meta = MODE_META[mode];
  $('modeHint').textContent = meta.hint;
  $('btnDownloadLabel').textContent = meta.action;

  // 详情视图内的字段开关
  $('qualityField').hidden = mode === 'cover';
  $('qualityLabel').textContent = meta.label;

  // 批量工具条
  $('batchQualityLabel').textContent = meta.batchLabel;
  $('batchQualityField').hidden = mode === 'cover';

  // 批量行里的动作按钮文字要跟着模式走
  document.querySelectorAll('[data-act="single"]').forEach((b) => {
    b.textContent = meta.action;
  });

  // 分集只在视频 / 音频模式下有意义（封面不分 P）
  const info = state.items.length === 1 ? state.items[0].info : null;
  const multi = Boolean(info && info.pages && info.pages.length > 1);
  $('partsWrap').hidden = !(multi && mode !== 'cover');

  updateDownloadLabel();

  // 已解析的结果需要按新模式重新取质量
  if (state.items.length === 1) {
    loadQualities();
  } else if (state.items.length > 1) {
    loadBatchQualities();
  }
}

/* ============================================================
   解析
   ============================================================ */

async function doParse() {
  if (state.busy) return;

  const lines = splitInput();
  if (!lines.length) {
    notice('先粘贴一条 B 站链接，或直接输入 BV 号', 'error', 3200);
    $('input').focus();
    return;
  }

  state.busy = true;
  const btn = $('btnParse');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 解析中';
  clearNotice();

  try {
    // 先把容器显示出来，再渲染内容：
    // 否则入场动画观察器会盯上一个 display:none 的节点，导致卡片一直停在 opacity:0
    $('resultSection').hidden = false;
    $('queueIdx').textContent = '03';
    $('tipsIdx').textContent = '04';

    if (lines.length === 1) {
      const info = await api('/api/parse?url=' + encodeURIComponent(lines[0]));
      state.items = [{ input: lines[0], info, ok: true, selected: true, error: '' }];
      state.activeIdx = 0;
      state.pageIndex = Math.max(0, (info.currentPage || 1) - 1);
      pushRecent(lines[0], info.title);
      renderSingle();
    } else {
      const results = await api('/api/batch-parse', {
        method: 'POST',
        body: JSON.stringify({ urls: lines }),
      });
      state.items = results.map((r, i) => ({
        input: r.input,
        info: r.data || null,
        ok: r.ok,
        error: r.error || '',
        selected: r.ok,
        key: 'b' + i,
      }));

      // 批量里成功的都记进最近记录
      results.forEach((r) => {
        if (r.ok && r.data) pushRecent(r.input, r.data.title);
      });

      $('stepsRow').hidden = true;
      renderBatch();
    }
    $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await (state.items.length === 1 ? loadQualities() : loadBatchQualities());
  } catch (e) {
    notice(e.message, 'error');
    $('resultSection').hidden = true;
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/* ============================================================
   单条详情渲染
   ============================================================ */

function renderSingle() {
  const item = state.items[0];
  const info = item.info;

  $('singleView').hidden = false;
  $('batchView').hidden = true;
  $('stepsRow').hidden = true;
  $('resultMeta').textContent = info.type === 'bangumi' ? '番剧' : '单条解析';

  const coverEl = $('coverImg');
  coverEl.src = info.cover ? '/api/cover?url=' + encodeURIComponent(info.cover) : '';
  bindImgSkeleton(coverEl);
  $('coverDur').textContent = info.duration ? fmtDuration(info.duration) : '—';

  $('dEyebrowId').textContent = info.bvid || (info.aid ? 'av' + info.aid : '—');
  $('dEyebrowDate').textContent = info.pubdate ? fmtDate(info.pubdate) : '—';
  $('dEyebrowType').textContent = info.type === 'bangumi' ? '番剧' : (info.tname || '视频');

  $('dTitle').textContent = info.title;

  // 用封面给卡片顶部铺一层柔光底色，卡片不再是死白的方块
  const detail = $('singleView');
  if (info.cover) {
    detail.style.setProperty(
      '--cover-wash',
      `url("/api/cover?url=${encodeURIComponent(info.cover)}")`
    );
  } else {
    detail.style.removeProperty('--cover-wash');
  }

  const avatar = info.owner && info.owner.face;
  const av = $('dAvatar');
  if (avatar) {
    av.src = '/api/cover?url=' + encodeURIComponent(avatar);
    av.hidden = false;
  } else {
    av.hidden = true;
  }
  $('dOwner').textContent = (info.owner && info.owner.name) || '未知 UP';

  // 粉丝数：取不到就整块隐藏，不留空胶囊
  const fansEl = $('dFans');
  const fans = Number(info.owner && info.owner.fans);
  if (fans > 0) {
    fansEl.textContent = `${fmtNum(fans)} 粉丝`;
    fansEl.hidden = false;
  } else {
    fansEl.hidden = true;
  }

  renderStats(info);

  // 简介：填满右侧中段的空档，也给用户一个「这视频讲什么」的判断依据
  const descEl = $('dDesc');
  const desc = String(info.desc || '').trim();
  if (desc) {
    descEl.textContent = desc;
    descEl.hidden = false;
  } else {
    descEl.hidden = true;
  }

  // 分集：多选（封面模式不需要）
  const pages = info.pages || [];
  const multi = pages.length > 1;
  $('partsWrap').hidden = !multi || state.mode === 'cover';

  if (multi) {
    state.selectedPages = new Set([state.pageIndex]);
    $('partsLabel').textContent = `分集 ${pages.length}`;
    renderParts();
  } else {
    state.selectedPages = new Set([0]);
  }

  updateDownloadLabel();
  watchFadeUp($('singleView'));
}

/* ============================================================
   统计栏
   ============================================================ */

const STAT_DEFS = [
  {
    key: 'view',
    label: '播放',
    k: 'view',
    icon: '<path d="M8.4 5.6v12.8L19 12z" fill="currentColor" stroke="none"/>',
  },
  {
    key: 'like',
    label: '点赞',
    k: 'like',
    icon:
      '<path d="M7 21V10.6l3.9-6.9a1.9 1.9 0 0 1 2.6-.8l.4.2a1.9 1.9 0 0 1 1 2L14.6 9H19a2 2 0 0 1 1.97 2.4l-1.15 6.3A3 3 0 0 1 17 20.6H7z"/><path d="M7 10.6H4.4V21H7"/>',
  },
  {
    key: 'coin',
    label: '投币',
    k: 'coin',
    icon:
      '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4v9.2M9.4 10h5.2M9.4 14h5.2"/>',
  },
  {
    key: 'favorite',
    label: '收藏',
    k: 'fav',
    icon:
      '<path d="M12 3.4l2.62 5.5 5.98.82-4.36 4.2 1.06 5.94L12 17.02 6.7 19.86l1.06-5.94L3.4 9.72l5.98-.82z"/>',
  },
];

function renderStats(info) {
  const s = info.stat || {};

  $('dStats').innerHTML = STAT_DEFS.map((d) => {
    const v = Number(s[d.key]) || 0;
    return `
      <div class="stat" data-k="${d.k}">
        <span class="stat-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d.icon}</svg>
        </span>
        <span class="stat-num">${v > 0 ? fmtNum(v) : '—'}</span>
        <span class="stat-label">${d.label}</span>
      </div>`;
  }).join('');

  // 次要数据放一行，不跟主数据抢注意力
  const extra = [
    ['弹幕', s.danmaku],
    ['评论', s.reply],
    ['分享', s.share],
  ].filter(([, v]) => Number(v) > 0);

  if (extra.length) {
    $('dStatsMore').innerHTML = extra
      .map(([k, v]) => `<span><b>${fmtNum(v)}</b>${k}</span>`)
      .join('<i aria-hidden="true"></i>');
    $('dStatsMore').hidden = false;
  } else {
    $('dStatsMore').hidden = true;
  }
}

/* ============================================================
   分集多选
   ============================================================ */

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function renderParts() {
  const info = state.items[0] && state.items[0].info;
  if (!info) return;
  const pages = info.pages || [];

  $('partsList').innerHTML = pages
    .map(
      (p, i) => `
      <button class="part-item" type="button" data-i="${i}"
        aria-pressed="${state.selectedPages.has(i)}"
        title="P${p.index} ${esc(p.part)}">
        <span class="pi-box" aria-hidden="true">${CHECK_ICON}</span>
        <span class="pi-no">P${p.index}</span>
        <span class="pi-name">${esc(p.part)}</span>
        <span class="pi-dur">${p.duration ? fmtDuration(p.duration) : ''}</span>
      </button>`
    )
    .join('');

  $('partsList').querySelectorAll('.part-item').forEach((b) => {
    b.addEventListener('click', () => togglePart(Number(b.dataset.i)));
  });

  syncParts();
}

/** 同步勾选态、已选数量、合计时长与下载按钮文案 */
function syncParts() {
  const info = state.items[0] && state.items[0].info;
  if (!info) return;
  const pages = info.pages || [];
  const total = pages.length;
  const picked = [...state.selectedPages].sort((a, b) => a - b);
  const dur = picked.reduce((sum, i) => sum + (pages[i] ? pages[i].duration : 0), 0);

  $('partsList').querySelectorAll('.part-item').forEach((b) => {
    b.setAttribute('aria-pressed', String(state.selectedPages.has(Number(b.dataset.i))));
  });

  // 300px 宽的一列塞不下长句，压成「1/4 · 2:48」，完整说法放 title
  $('partsSum').textContent = `${picked.length}/${total}${dur ? ' · ' + fmtDuration(dur) : ''}`;
  $('partsSum').title = `已选 ${picked.length} / ${total} 个分集${
    dur ? '，合计 ' + fmtDuration(dur) : ''
  }`;

  $('btnPartsAll').disabled = picked.length === total;
  $('btnPartsNone').disabled = picked.length === 0;

  updateDownloadLabel();
}

function togglePart(i) {
  if (state.selectedPages.has(i)) state.selectedPages.delete(i);
  else state.selectedPages.add(i);

  // 清晰度以「第一个选中的分集」为准，避免多选时反复探测
  const first = [...state.selectedPages].sort((a, b) => a - b)[0];
  const needProbe = first !== undefined && first !== state.pageIndex;
  if (needProbe) state.pageIndex = first;

  syncParts();
  if (needProbe) loadQualities();
}

function pickAllParts(on) {
  const info = state.items[0] && state.items[0].info;
  if (!info) return;
  const pages = info.pages || [];

  state.selectedPages = on ? new Set(pages.map((_, i) => i)) : new Set();
  if (on && state.pageIndex !== 0) {
    state.pageIndex = 0;
    loadQualities();
  }
  syncParts();
}

/** 下载按钮文案随选中数量变化 */
function updateDownloadLabel() {
  const btn = $('btnDownload');
  const label = $('btnDownloadLabel');
  const meta = MODE_META[state.mode];

  const info = state.items[0] && state.items[0].info;
  const pages = (info && info.pages) || [];
  const multi = pages.length > 1 && state.mode !== 'cover';

  if (!multi) {
    label.textContent = meta.action;
    btn.disabled = false;
    return;
  }

  const picked = [...state.selectedPages].sort((a, b) => a - b);
  if (!picked.length) {
    label.textContent = '请选择分集';
    btn.disabled = true;
    return;
  }

  btn.disabled = false;
  const isAudio = state.mode === 'audio';
  label.textContent =
    picked.length === 1
      ? `下载 P${pages[picked[0]].index}${isAudio ? ' 音频' : ''}`
      : `下载 ${picked.length} 个${isAudio ? '音频' : '分集'}`;
}

/* ============================================================
   质量列表
   ============================================================ */

function currentPage() {
  const info = state.items[state.activeIdx] && state.items[state.activeIdx].info;
  if (!info || !info.pages) return null;
  return info.pages[state.pageIndex] || info.pages[0] || null;
}

function pageQuery(page) {
  const qs = new URLSearchParams({ cid: page.cid });
  if (page.epId) qs.set('epId', page.epId);
  else if (page.bvid) qs.set('bvid', page.bvid);
  else if (page.aid) qs.set('aid', page.aid);
  return qs.toString();
}

async function loadQualities() {
  const sel = $('qualitySelect');
  const item = state.items[0];
  if (!item || !item.info) return;

  if (state.mode === 'cover') {
    sel.innerHTML = '<option value="orig">原图 JPG</option>';
    sel.disabled = false;
    return;
  }

  const page = currentPage();
  if (!page) return;

  sel.disabled = true;
  sel.innerHTML = '<option value="">读取中…</option>';

  try {
    if (state.mode === 'video') {
      const raw = await api('/api/qualities?' + pageQuery(page));
      // 在线版只走访客 DURL，最高 720P；高清留给本机版
      state.qualities = (raw || []).filter((q) => Number(q.qn) <= 74);
      $('qualityLabel').textContent = state.demo ? '清晰度 · 在线≤720P' : '清晰度';
      if (!state.qualities.length) {
        sel.innerHTML = '<option value="">无可用清晰度</option>';
        return;
      }
      sel.innerHTML = state.qualities
        .map((q) => `<option value="${q.qn}">${esc(q.label)}</option>`)
        .join('');
      // 恢复上次选的清晰度；没选过就默认 1080P（其次 720P），
      // 避免一上来就选中 4K —— 那体积对多数人没必要
      const wantQn = Number(loadPref().qn);
      let hitQn = state.qualities.findIndex((q) => q.qn === wantQn);
      if (hitQn < 0) {
        for (const prefer of [80, 64, 116, 120]) {
          hitQn = state.qualities.findIndex((q) => q.qn === prefer);
          if (hitQn >= 0) break;
        }
      }
      sel.selectedIndex = hitQn >= 0 ? hitQn : 0;
    } else {
      const list = await api('/api/audio-qualities?' + pageQuery(page));
      state.qualities = list || [];
      if (!state.qualities.length) {
        sel.innerHTML = '<option value="">无可用音轨</option>';
        return;
      }
      sel.innerHTML = state.qualities
        .map((a) => `<option value="${a.id}">${esc(a.label)}</option>`)
        .join('');
      // 恢复上次选的音质
      const wantAid = Number(loadPref().audioId);
      const hitAid = state.qualities.findIndex((a) => a.id === wantAid);
      sel.selectedIndex = hitAid >= 0 ? hitAid : 0;
    }
  } catch (e) {
    sel.innerHTML = '<option value="">读取失败</option>';
    notice('质量列表读取失败：' + e.message, 'error', 5000);
  } finally {
    sel.disabled = false;
  }
}

/* ============================================================
   批量视图
   ============================================================ */

function renderBatch() {
  $('singleView').hidden = true;
  $('batchView').hidden = false;

  const okCount = state.items.filter((i) => i.ok).length;
  $('resultMeta').textContent = `${okCount} / ${state.items.length} 条有效`;

  $('batchList').innerHTML = state.items
    .map((item, i) => {
      if (!item.ok) {
        return `
          <li class="batch-row is-error" data-i="${i}">
            <span></span>
            <span></span>
            <div class="batch-main">
              <div class="batch-title" style="color:var(--paper-300)">${esc(item.input)}</div>
              <div class="batch-meta"><span class="err">${esc(item.error)}</span></div>
            </div>
            <span></span>
          </li>`;
      }

      const v = item.info;
      const pages = v.pages || [];
      const multi = pages.length > 1;
      return `
        <li class="batch-row" data-i="${i}">
          <label class="check">
            <input type="checkbox" data-check="${i}" ${item.selected ? 'checked' : ''} />
            <span aria-hidden="true"></span>
            <span class="sr-only">选择 ${esc(v.title)}</span>
          </label>
          <img class="batch-thumb" src="${v.cover ? '/api/cover?url=' + encodeURIComponent(v.cover) : ''}" alt="" loading="lazy" />
          <div class="batch-main">
            <div class="batch-title">${esc(v.title)}</div>
            <div class="batch-meta">
              <span>${esc(v.bvid || 'av' + v.aid)}</span>
              <span>·</span>
              <span>${fmtDuration(v.duration)}</span>
              ${multi ? `<span>·</span><span>${pages.length}P · 默认第 1 集</span>` : ''}
            </div>
          </div>
          <div class="batch-actions">
            <button class="btn btn-mini" data-act="single" data-i="${i}">${MODE_META[state.mode].action}</button>
          </div>
        </li>`;
    })
    .join('');

  // 勾选
  $('batchList').querySelectorAll('[data-check]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const i = Number(cb.dataset.check);
      state.items[i].selected = cb.checked;
      updateBatchCount();
    });
  });

  // 单条下载
  $('batchList').querySelectorAll('[data-act="single"]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      downloadItem(state.items[i], i);
    });
  });

  // 缩略图骨架 + 批量行依次进场
  $('batchList').querySelectorAll('.batch-thumb').forEach(bindImgSkeleton);
  $('batchList')
    .querySelectorAll('.batch-row')
    .forEach((row, i) => watchFadeUp(row, i * 55));

  updateBatchCount();
}

function updateBatchCount() {
  const total = state.items.filter((i) => i.ok).length;
  const sel = state.items.filter((i) => i.ok && i.selected).length;
  $('batchCount').textContent = `${sel} / ${total}`;
  $('checkAll').checked = total > 0 && sel === total;
  $('btnBatchDownload').disabled = sel === 0;
}

async function loadBatchQualities() {
  const sel = $('batchQuality');
  if (state.mode === 'cover') {
    sel.innerHTML = '<option value="orig">原图 JPG</option>';
    return;
  }

  const first = state.items.find((i) => i.ok);
  if (!first) return;

  sel.disabled = true;
  sel.innerHTML = '<option>读取中…</option>';

  try {
    const page = first.info.pages[0];
    if (state.mode === 'video') {
      const raw = await api('/api/qualities?' + pageQuery(page));
      state.batchQualities = (raw || []).filter((q) => Number(q.qn) <= 74);
      $('batchQualityLabel').textContent = state.demo ? '清晰度 · ≤720P' : '清晰度';
      sel.innerHTML = state.batchQualities.length
        ? state.batchQualities.map((q) => `<option value="${q.qn}">${esc(q.label)}</option>`).join('')
        : '<option value="">无可用</option>';
      sel.selectedIndex = 0;
    } else {
      const list = await api('/api/audio-qualities?' + pageQuery(page));
      state.batchQualities = list || [];
      sel.innerHTML = state.batchQualities.length
        ? state.batchQualities.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('')
        : '<option value="">无可用</option>';
      sel.selectedIndex = 0;
    }
  } catch (e) {
    sel.innerHTML = '<option value="">读取失败</option>';
    notice('批量质量读取失败：' + e.message, 'error', 5000);
  } finally {
    sel.disabled = false;
  }
}

/* ============================================================
   下载
   ============================================================ */

/** 在线版：拼出受控下载链接，只带解析结果里的标识，不接受任意地址 */
function demoDownloadUrl({ type = 'video', page = null, info = null, quality = 0 }) {
  const qs = new URLSearchParams({
    type,
    title: (info && info.title) || 'bilibili',
    part: (page && page.part) || '',
    index: String((page && page.index) || 1),
    pageCount: String((info && info.pages && info.pages.length) || 1),
  });

  if (type === 'cover') {
    qs.set('url', (info && info.cover) || '');
  } else {
    qs.set('cid', (page && page.cid) || '');
    if (page && page.epId) qs.set('epId', page.epId);
    else if ((page && page.bvid) || (info && info.bvid)) {
      qs.set('bvid', (page && page.bvid) || info.bvid);
    } else if ((page && page.aid) || (info && info.aid)) {
      qs.set('aid', String((page && page.aid) || info.aid));
    }
    if (type === 'video') qs.set('qn', String(quality || 64));
    else qs.set('audioId', String(quality || 30280));
  }
  return '/api/demo/download?' + qs.toString();
}

/** 用浏览器原生下载，服务端只转字节流；不做 fetch 缓冲 */
function triggerDemoDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

async function downloadItem(item, opts = {}) {
  const silent = Boolean(opts.silent);
  const info = item.info;
  if (!info) return false;

  const page0 = info.pages && info.pages[0];
  if (!page0) return false;

  if (state.demo) {
    const type = state.mode === 'audio' ? 'audio' : state.mode === 'cover' ? 'cover' : 'video';
    const quality =
      type === 'audio'
        ? Number($('batchQuality').value) || 30280
        : Number($('batchQuality').value) || 64;
    triggerDemoDownload(demoDownloadUrl({ type, page: page0, info, quality }));
    if (!silent) notice('已开始下载', 'ok', 2200);
    return true;
  }

  try {
    if (state.mode === 'cover') {
      await api('/api/download-cover', {
        method: 'POST',
        body: JSON.stringify({ url: info.cover, title: info.title }),
      });
      if (!silent) notice('封面已加入队列', 'ok', 2600);
      pollTasks();
      return true;
    }

    if (state.mode === 'video') {
      const qn = Number($('batchQuality').value) || 64;
      savePref({ qn });
      await api('/api/download', {
        method: 'POST',
        body: JSON.stringify({
          bvid: page0.bvid || info.bvid,
          aid: page0.aid || info.aid,
          epId: page0.epId || '',
          cid: page0.cid,
          qn,
          title: info.title,
          part: page0.part,
          index: page0.index,
          pageCount: info.pages.length,
        }),
      });
    } else {
      const audioId = Number($('batchQuality').value) || 30280;
      savePref({ audioId });
      await api('/api/download-audio', {
        method: 'POST',
        body: JSON.stringify({
          bvid: page0.bvid || info.bvid,
          aid: page0.aid || info.aid,
          epId: page0.epId || '',
          cid: page0.cid,
          audioId,
          title: info.title,
          part: page0.part,
          index: page0.index,
          pageCount: info.pages.length,
        }),
      });
    }

    if (!silent) notice('已加入下载队列', 'ok', 2200);
    pollTasks();
    return true;
  } catch (e) {
    if (!silent) notice('下载失败：' + e.message, 'error', 6000);
    return false;
  }
}

async function downloadCurrent() {
  if (state.demo) {
    notice('在线演示版只提供解析，下载请在本机运行', 'info', 5000);
    return;
  }

  const item = state.items[0];
  if (!item || !item.info) return;

  const info = item.info;
  const pages = info.pages || [];
  if (!pages.length) return;

  /* ---------- 在线版：浏览器直收，不进服务器写盘队列 ---------- */
  if (state.demo) {
    if (state.mode === 'cover') {
      triggerDemoDownload(demoDownloadUrl({ type: 'cover', info }));
      notice('已开始下载封面', 'ok', 2600);
      return;
    }

    const demoPicks =
      pages.length > 1
        ? [...state.selectedPages].sort((a, b) => a - b).map((i) => pages[i])
        : [pages[0]];
    if (!demoPicks.length) {
      notice('先勾选要下载的分集', 'error', 2600);
      return;
    }

    const demoQv = Number($('qualitySelect').value);
    if (!demoQv) {
      notice(state.mode === 'video' ? '清晰度还在读取，稍等一下' : '音质还在读取，稍等一下', 'error', 2600);
      return;
    }

    for (let i = 0; i < demoPicks.length; i++) {
      triggerDemoDownload(
        demoDownloadUrl({ type: state.mode, page: demoPicks[i], info, quality: demoQv })
      );
      if (i < demoPicks.length - 1) await new Promise((r) => setTimeout(r, 350));
    }
    notice(
      demoPicks.length > 1
        ? `已发起 ${demoPicks.length} 个下载，如浏览器拦截请允许本站多文件下载`
        : '已开始下载',
      'ok',
      3200
    );
    return;
  }

  const btn = $('btnDownload');

  /* ---------- 封面：与分集无关，永远只下一次 ---------- */
  if (state.mode === 'cover') {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 准备中';
    try {
      await api('/api/download-cover', {
        method: 'POST',
        body: JSON.stringify({ url: info.cover, title: info.title }),
      });
      notice('封面已加入队列', 'ok', 2600);
      pollTasks();
    } catch (e) {
      notice('下载失败：' + e.message, 'error', 6000);
    } finally {
      btn.innerHTML = original;
      updateDownloadLabel();
    }
    return;
  }

  /* ---------- 视频 / 音频：按勾选的分集逐个入队 ---------- */
  const picks =
    pages.length > 1
      ? [...state.selectedPages].sort((a, b) => a - b).map((i) => pages[i])
      : [pages[0]];

  if (!picks.length) {
    notice('先勾选要下载的分集', 'error', 2600);
    return;
  }

  const qv = Number($('qualitySelect').value);
  if (!qv) {
    notice(state.mode === 'video' ? '清晰度还在读取，稍等一下' : '音质还在读取，稍等一下', 'error', 2600);
    return;
  }

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 提交中';

  let ok = 0;
  let fail = 0;

  try {
    for (const page of picks) {
      try {
        if (state.mode === 'video') {
          savePref({ qn: qv });
          await api('/api/download', {
            method: 'POST',
            body: JSON.stringify({
              bvid: page.bvid || info.bvid,
              aid: page.aid || info.aid,
              epId: page.epId || '',
              cid: page.cid,
              qn: qv,
              title: info.title,
              part: page.part,
              index: page.index,
              pageCount: pages.length,
            }),
          });
        } else {
          savePref({ audioId: qv });
          await api('/api/download-audio', {
            method: 'POST',
            body: JSON.stringify({
              bvid: page.bvid || info.bvid,
              aid: page.aid || info.aid,
              epId: page.epId || '',
              cid: page.cid,
              audioId: qv,
              title: info.title,
              part: page.part,
              index: page.index,
              pageCount: pages.length,
            }),
          });
        }
        ok++;
      } catch {
        fail++;
      }
      // 稍作间隔，避免瞬时把接口打满
      await new Promise((r) => setTimeout(r, 140));
    }

    if (fail) notice(`已提交 ${ok} 个，${fail} 个失败`, 'error', 4200);
    else notice(ok > 1 ? `已提交 ${ok} 个分集到队列` : '已加入下载队列', 'ok', 2600);
    pollTasks();
  } finally {
    btn.innerHTML = original;
    updateDownloadLabel();
  }
}

async function batchDownload() {
  const picks = state.items.filter((i) => i.ok && i.selected);
  if (!picks.length) {
    notice('先勾选要下载的条目', 'error', 2600);
    return;
  }

  const btn = $('btnBatchDownload');
  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> 提交中';

  let ok = 0;
  let fail = 0;

  for (const item of picks) {
    const done = await downloadItem(item, { silent: true });
    if (done) ok++;
    else fail++;
    // 轻微间隔，避免瞬时把接口打满
    await new Promise((r) => setTimeout(r, 160));
  }

  btn.disabled = false;
  btn.textContent = original;

  notice(
    fail ? `已提交 ${ok} 个任务，${fail} 个失败` : `已提交 ${ok} 个任务`,
    fail ? 'error' : 'ok',
    3000
  );
}

/* ============================================================
   任务队列
   ============================================================ */

const STATUS_TEXT = {
  queued: '排队中',
  resolving: '取地址',
  downloading: '下载中',
  merging: '合并中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
};

/* ============================================================
   任务队列渲染（DOM 复用，避免进度条闪烁）
   ============================================================ */

function renderTasks(tasks) {
  const list = $('taskList');

  $('queueMeta').textContent = tasks.length
    ? `${tasks.filter((t) => t.status === 'done').length} / ${tasks.length} 完成`
    : '空闲';

  if (!tasks.length) {
    list.innerHTML = `
      <li class="empty">
        <div class="empty-mark">暂无任务</div>
        <p>还没有任务<br />贴一条链接，点解析</p>
      </li>`;
    state.lastTaskSig = '';
    return;
  }

  const emptyLi = list.querySelector('.empty');
  if (emptyLi) emptyLi.remove();

  tasks.forEach((t, i) => {
    let row = list.querySelector(`[data-id="${t.id}"]`);

    if (!row) {
      row = document.createElement('li');
      row.className = 'task-row';
      row.dataset.id = t.id;
      row.innerHTML = `
        <span class="task-idx">${pad2(i + 1)}</span>
        <div class="task-main">
          <div class="task-name"></div>
          <div class="task-meta"></div>
          <div class="task-bar"><i></i></div>
          <div class="task-err" hidden></div>
        </div>
        <div class="task-side">
          <span class="task-state"></span>
          <button class="task-act" type="button" hidden></button>
        </div>`;
    }

    // 服务端按开始时间倒序返回，这里同步 DOM 顺序，新任务始终在最前
    const current = list.children[i];
    if (current !== row) list.insertBefore(row, current || null);

    updateTaskRow(row, t, i);
  });

  // 移除服务端已丢弃的
  const ids = new Set(tasks.map((t) => t.id));
  list.querySelectorAll('.task-row').forEach((r) => {
    if (!ids.has(r.dataset.id)) r.remove();
  });
}

function updateTaskRow(row, t, index) {
  const pct = t.total > 0 ? Math.min(100, (t.downloaded / t.total) * 100) : 0;

  row.querySelector('.task-idx').textContent = pad2(index + 1);
  row.querySelector('.task-name').textContent = t.filename || t.title;
  row.querySelector('.task-name').title = t.filename || t.title;

  const bar = row.querySelector('.task-bar i');
  bar.style.width = (t.status === 'done' ? 100 : pct) + '%';
  bar.className = t.status === 'done' ? 'done' : t.status === 'error' ? 'err' : '';

  const stateEl = row.querySelector('.task-state');
  stateEl.textContent = STATUS_TEXT[t.status] || t.status;
  stateEl.dataset.s = t.status;

  const meta = row.querySelector('.task-meta');
  let parts = [];

  if (t.status === 'done') {
    if (t.quality) parts.push(esc(t.quality));
    parts.push(fmtBytes(t.total || t.downloaded));
  } else if (t.status === 'downloading') {
    if (t.quality) parts.push(esc(t.quality));
    parts.push(
      t.total > 0
        ? `${fmtBytes(t.downloaded)} / ${fmtBytes(t.total)}`
        : fmtBytes(t.downloaded)
    );
    if (t.speed > 0) parts.push(`${fmtBytes(t.speed)}/s`);
    parts.push(`${pct.toFixed(0)}%`);
  } else if (t.status === 'queued' || t.status === 'resolving') {
    if (t.quality) parts.push(esc(t.quality));
    parts.push(t.status === 'queued' ? '排队等待' : '获取地址');
  } else {
    if (t.quality) parts.push(esc(t.quality));
  }

  meta.innerHTML = parts.join('<span class="dot"></span>');

  const errEl = row.querySelector('.task-err');
  if (t.status === 'error' && t.error) {
    errEl.hidden = false;
    errEl.textContent = t.error;
  } else {
    errEl.hidden = true;
  }

  // 操作按钮：进行中 → 取消；失败 / 已取消 → 重试
  const act = row.querySelector('.task-act');
  if (act) {
    if (t.canCancel) {
      act.hidden = false;
      act.dataset.act = 'cancel';
      act.dataset.id = t.id;
      act.textContent = '取消';
      act.title = '取消这个任务';
    } else if (t.status === 'error' || t.status === 'canceled') {
      act.hidden = false;
      act.dataset.act = 'retry';
      act.dataset.id = t.id;
      act.textContent = '重试';
      act.title = '重新下载这个任务';
    } else {
      act.hidden = true;
      act.dataset.act = '';
      act.dataset.id = '';
    }
  }
}

/** 取消单个任务（排队 / 取地址 / 下载 / 合并都能停） */
async function cancelOneTask(id) {
  try {
    await api('/api/cancel?id=' + encodeURIComponent(id));
    pollTasks();
  } catch (e) {
    notice('取消失败：' + e.message, 'error', 4000);
  }
}

/** 重试失败或已取消的任务（服务端复用原始参数） */
async function retryOneTask(id) {
  try {
    await api('/api/retry?id=' + encodeURIComponent(id), { method: 'POST' });
    notice('已重新加入队列', 'ok', 2200);
    pollTasks();
  } catch (e) {
    notice('重试失败：' + e.message, 'error', 4000);
  }
}

/* ============================================================
   轮询
   ============================================================ */

let polling = false;

async function pollTasks() {
  if (polling) return;
  polling = true;

  try {
    const tasks = await api('/api/tasks');
    renderTasks(tasks);

    const active = tasks.some(
      (t) =>
        t.status === 'downloading' ||
        t.status === 'queued' ||
        t.status === 'resolving' ||
        t.status === 'merging'
    );

    if (active && !state.taskTimer) {
      state.taskTimer = setInterval(pollTasks, 800);
    } else if (!active && state.taskTimer) {
      clearInterval(state.taskTimer);
      state.taskTimer = null;
    }
  } catch {
    /* 服务关闭时静默 */
  } finally {
    polling = false;
  }
}

/* ============================================================
   账号 / 登录
   ============================================================ */

/** 清晰度说明条：把「什么条件能下到哪一档」讲清楚 */
function renderHdNote(cfg) {
  const box = $('hdNote');
  const txt = $('hdNoteText');
  if (!box || !txt) return;

  const hasCookie = Boolean(cfg && cfg.hasCookie);
  const hasFfmpeg = Boolean(cfg && cfg.hasFfmpeg);

  let html;
  if (hasCookie && hasFfmpeg) {
    html = '已解锁 <b>1080P / 1080P60 / 4K</b>，下载后自动合并音视频';
  } else if (hasCookie && !hasFfmpeg) {
    html = '缺少 ffmpeg，最高 <b>720P</b>；装好依赖即可解锁高清';
  } else if (!hasCookie && hasFfmpeg) {
    html = '登录后可下 <b>1080P / 4K</b>，720P 及以下免登录';
  } else {
    html = '720P 及以下免登录，高清需登录并安装依赖';
  }

  txt.innerHTML = html;
  box.hidden = false;
}

async function refreshHdNote() {
  try {
    const cfg = await api('/api/config');
    renderHdNote(cfg);
  } catch {
    /* 忽略 */
  }
}

/** 在线演示：可下载视频(≤720P)/音频/封面；登录与设置仍关闭 */
function enableDemo() {
  state.demo = true;
  document.body.classList.add('is-demo');
  const bar = $('demoBar');
  if (bar) bar.hidden = false;
  updateDownloadLabel();
}

function applyAccount(user) {
  state.account = user || null;

  const avatarImg = $('accountAvatar');
  const fallback = $('accountAvatarFallback');

  if (user) {
    $('accountName').textContent = user.name || '已登录';
    if (user.face) {
      avatarImg.src = '/api/cover?url=' + encodeURIComponent(user.face);
      avatarImg.hidden = false;
      fallback.hidden = true;
    } else {
      avatarImg.hidden = true;
      fallback.hidden = false;
      fallback.textContent = (user.name || '已')[0];
    }
    $('footerMode').textContent = `已登录 · ${user.name}`;
  } else {
    avatarImg.hidden = true;
    fallback.hidden = false;
    fallback.textContent = '游';
    $('accountName').textContent = '游客';
    $('footerMode').textContent = '访客模式 · 最高 720P';
  }
}

async function refreshAccount() {
  try {
    const d = await api('/api/user');
    applyAccount(d.user);
  } catch {
    applyAccount(null);
  }
}

function openLogin() {
  if (state.demo) {
    notice('在线演示版不提供登录，扫码登录请在本机运行', 'info', 4200);
    return;
  }

  $('loginMask').classList.add('show');

  if (state.account) {
    showLoginUser(state.account);
  } else {
    showLoginQr();
    startQrFlow();
  }
}

function showLoginUser(user) {
  $('loginQrArea').hidden = true;
  $('loginUserArea').hidden = false;

  $('loginUserName').textContent = user.name || '已登录';
  const meta = [];
  if (user.mid) meta.push('UID ' + user.mid);
  if (user.level) meta.push('LV' + user.level);
  if (user.vip) meta.push('大会员');
  $('loginUserMeta').textContent = meta.join(' · ') || '已登录';

  const img = $('loginUserAvatar');
  if (user.face) {
    img.src = '/api/cover?url=' + encodeURIComponent(user.face);
    img.style.display = '';
  } else {
    img.style.display = 'none';
  }
}

function showLoginQr() {
  $('loginQrArea').hidden = false;
  $('loginUserArea').hidden = true;
}

function setQrStatus(text, kind = '') {
  const el = $('qrStatus');
  el.className = 'st' + (kind ? ' ' + kind : '');
  el.innerHTML = `<span class="pulse" aria-hidden="true"></span>${esc(text)}`;
}

async function startQrFlow() {
  stopQrTimer();
  state.loginState = 'loading';
  $('qrStage').classList.remove('is-dim');
  setQrStatus('正在申请二维码…');

  try {
    const d = await api('/api/login/qr', { method: 'POST' });
    state.loginKey = d.qrcodeKey;
    $('qrImg').src = d.qrImg;
    $('qrStage').classList.remove('is-dim');
    setQrStatus('用 B 站手机客户端扫一扫');
    state.loginState = 'waiting';

    // 每 2 秒问一次扫码结果
    state.loginTimer = setInterval(pollLogin, 2000);
  } catch (e) {
    setQrStatus('申请失败：' + e.message, 'warn');
    $('qrStage').classList.add('is-dim');
    $('veilText').textContent = '二维码获取失败';
    $('veilSub').textContent = '点下方按钮重试';
  }
}

function stopQrTimer() {
  if (state.loginTimer) {
    clearInterval(state.loginTimer);
    state.loginTimer = null;
  }
}

async function pollLogin() {
  if (!state.loginKey) return;

  try {
    const d = await api('/api/login/poll?key=' + encodeURIComponent(state.loginKey));

    if (d.status === 'waiting') {
      setQrStatus('用 B 站手机客户端扫一扫');
    } else if (d.status === 'scanned') {
      state.loginState = 'scanned';
      setQrStatus('已扫码，请在手机上确认登录', 'warn');
    } else if (d.status === 'expired') {
      stopQrTimer();
      state.loginState = 'expired';
      $('qrStage').classList.add('is-dim');
      $('veilText').textContent = '二维码已失效';
      $('veilSub').textContent = '点击「刷新二维码」重新获取';
      setQrStatus('二维码已失效', 'warn');
    } else if (d.status === 'ok') {
      stopQrTimer();
      state.loginState = 'ok';
      applyAccount(d.user);
      showLoginUser(d.user);
      notice(`已登录：${d.user ? d.user.name : ''}`, 'ok', 3200);

      // 登录后刷新清晰度说明与可选档位
      refreshHdNote();
      if (state.items.length === 1) loadQualities();
      else if (state.items.length > 1) loadBatchQualities();
    } else if (d.status === 'error') {
      stopQrTimer();
      setQrStatus(d.message || '登录失败', 'warn');
    }
  } catch {
    /* 网络抖动时继续轮询 */
  }
}

async function doLogout() {
  try {
    await api('/api/logout', { method: 'POST' });
    applyAccount(null);
    showLoginQr();
    startQrFlow();
    notice('已退出登录', 'info', 2600);
    if (state.items.length === 1) loadQualities();
    else if (state.items.length > 1) loadBatchQualities();
  } catch (e) {
    notice('退出失败：' + e.message, 'error', 4000);
  }
}

/* ============================================================
   设置
   ============================================================ */

async function openSettings() {
  try {
    const cfg = await api('/api/config');
    state.downloadDir = cfg.downloadDir || '';
    $('dirValue').textContent = state.downloadDir || '未设置';
    $('inputCookie').value = '';
    $('inputCookie').placeholder = cfg.hasCookie
      ? '已登录，留空表示不修改'
      : '粘贴 SESSDATA 的值';
    $('inputSea').checked = loadPref().sea !== false;
    $('settingsMask').classList.add('show');
    loadSecurity();
  } catch (e) {
    notice('读取设置失败：' + e.message, 'error', 4000);
  }
}

/**
 * 本机保护状态：只给结论，不在界面上罗列具体措施。
 * 细节留在这行注释里，方便以后排查：
 *   服务端会校验 Host / Origin / Sec-Fetch-Site，下发严格 CSP，
 *   凭证 AES-256-GCM 加密存放，config.json 权限只留当前用户。
 */
async function loadSecurity() {
  const line = $('secLine');
  const text = $('secText');
  if (!line || !text) return;

  try {
    const d = await api('/api/security');

    // 在线演示跑在公网容器里，本机隔离天然不适用，单独说明而不是报「异常」
    if (!d.localOnly) {
      line.dataset.ok = 'demo';
      text.textContent = '在线演示 · 本机版保护更完整';
      return;
    }

    const ok =
      d.localOnly &&
      d.hostGuard &&
      d.originGuard &&
      d.csp &&
      (!d.hasCredential || d.credentialEncrypted) &&
      d.configPerm === 'restricted';

    line.dataset.ok = String(ok);
    text.textContent = ok ? '已开启' : '未完全开启，重启程序可自动修复';
  } catch {
    line.dataset.ok = 'false';
    text.textContent = '未能确认';
  }
}

async function saveSettings() {
  const btn = $('btnSaveSettings');
  btn.disabled = true;

  try {
    const body = { downloadDir: state.downloadDir || '' };
    const ck = $('inputCookie').value.trim();

    // 把 cookie 一并提交（可能为空，表示不改）
    if (ck) body.cookie = ck;

    const cfg = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    $('settingsMask').classList.remove('show');
    applyAccount(cfg.user || null);
    state.downloadDir = cfg.downloadDir || '';
    $('btnOpenFolder').title = state.downloadDir || '打开下载文件夹';
    refreshHdNote();

    // 背景动效只存本地，不上传后端
    const seaOn = $('inputSea').checked;
    savePref({ sea: seaOn });
    if (window.SeaBubbles) window.SeaBubbles.setEnabled(seaOn);

    notice('设置已保存', 'ok', 2600);

    if (state.items.length === 1) loadQualities();
    else if (state.items.length > 1) loadBatchQualities();
  } catch (e) {
    notice('保存失败：' + e.message, 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   事件绑定
   ============================================================ */

function bind() {
  // 模式切换
  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  // 输入
  $('input').addEventListener('input', () => {
    updateInputCount();
    autoGrow();
  });
  $('input').addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter 解析（普通 Enter 用于换行，支持多条）
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doParse();
  });

  // 粘贴后若只有单条，自动解析
  $('input').addEventListener('paste', () => {
    setTimeout(() => {
      updateInputCount();
      autoGrow();
      const lines = splitInput();
      if (lines.length === 1 && /BV[0-9A-Za-z]{10}|b23\.tv|\bav\d{5,}|\/ep\d+/i.test(lines[0])) {
        doParse();
      }
    }, 70);
  });

  $('btnParse').addEventListener('click', doParse);
  $('btnDownload').addEventListener('click', downloadCurrent);
  $('btnBatchDownload').addEventListener('click', batchDownload);

  // 分集多选工具
  $('btnPartsAll').addEventListener('click', () => pickAllParts(true));
  $('btnPartsNone').addEventListener('click', () => pickAllParts(false));

  // 清空输入
  $('btnClearInput').addEventListener('click', () => {
    $('input').value = '';
    updateInputCount();
    autoGrow();
    $('input').focus();
  });

  // 全选
  $('checkAll').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.items.forEach((i) => {
      if (i.ok) i.selected = on;
    });
    $('batchList').querySelectorAll('[data-check]').forEach((cb) => {
      const i = Number(cb.dataset.check);
      cb.checked = Boolean(state.items[i] && state.items[i].selected);
    });
    updateBatchCount();
  });

  // 复制链接
  $('btnCopyLink').addEventListener('click', async () => {
    const item = state.items[0];
    if (!item || !item.info) return;
    const info = item.info;
    const page = currentPage();
    const link = info.isBangumi
      ? `https://www.bilibili.com/bangumi/play/ep${page && page.epId}`
      : `https://www.bilibili.com/video/${info.bvid}` +
        (info.pages.length > 1 ? `?p=${page && page.index}` : '');

    try {
      await navigator.clipboard.writeText(link);
      notice('链接已复制', 'ok', 2000);
    } catch {
      notice(link, 'info', 6000);
    }
  });

  // 打开下载目录
  const openFolder = async () => {
    try {
      await api('/api/open-folder');
      notice('已打开下载文件夹', 'ok', 1800);
    } catch (e) {
      notice('打开文件夹失败：' + e.message, 'error', 4000);
    }
  };
  $('btnOpenFolder').addEventListener('click', openFolder);

  // 清空已完成
  $('btnClearDone').addEventListener('click', () => {
    document.querySelectorAll('.task-row').forEach((r) => {
      const s = r.querySelector('.task-state');
      if (s && ['已完成', '失败', '已取消'].includes(s.textContent)) r.remove();
    });
    if (!document.querySelectorAll('.task-row').length) {
      $('taskList').innerHTML = `
      <li class="empty">
        <div class="empty-mark">暂无任务</div>
        <p>还没有任务<br />贴一条链接，点解析</p>
      </li>`;
    }
    $('queueMeta').textContent = '空闲';
  });

  // 任务卡上的取消 / 重试（事件委托，避免每行重复绑定）
  $('taskList').addEventListener('click', (e) => {
    const btn = e.target.closest('.task-act');
    if (!btn || btn.hidden) return;
    const id = btn.dataset.id;
    if (!id) return;
    if (btn.dataset.act === 'cancel') cancelOneTask(id);
    else if (btn.dataset.act === 'retry') retryOneTask(id);
  });

  // 账号 / 登录
  $('btnAccount').addEventListener('click', openLogin);
  $('btnCloseLogin').addEventListener('click', () => {
    $('loginMask').classList.remove('show');
    stopQrTimer();
  });
  $('btnRefreshQr').addEventListener('click', () => {
    $('qrStage').classList.remove('is-dim');
    startQrFlow();
  });
  $('btnLogout').addEventListener('click', doLogout);

  // 设置
  $('btnSettings').addEventListener('click', openSettings);
  $('btnTheme').addEventListener('click', toggleTheme);
  watchSystemTheme();
  $('btnCloseSettings').addEventListener('click', () => $('settingsMask').classList.remove('show'));
  $('btnCancelSettings').addEventListener('click', () => $('settingsMask').classList.remove('show'));
  $('btnSaveSettings').addEventListener('click', saveSettings);

  // 目录选择
  $('btnPickDir').addEventListener('click', openDirPicker);
  $('btnDirUp').addEventListener('click', () => loadDir(dirState.parent));
  $('btnChooseDir').addEventListener('click', chooseDir);
  $('btnCancelDir').addEventListener('click', () => $('dirMask').classList.remove('show'));
  $('btnCloseDir').addEventListener('click', () => $('dirMask').classList.remove('show'));
  $('dirMask').addEventListener('click', (e) => {
    if (e.target === $('dirMask')) $('dirMask').classList.remove('show');
  });

  // 点击遮罩关闭
  $('loginMask').addEventListener('click', (e) => {
    if (e.target === $('loginMask')) {
      $('loginMask').classList.remove('show');
      stopQrTimer();
    }
  });
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) $('settingsMask').classList.remove('show');
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('loginMask').classList.remove('show');
      $('settingsMask').classList.remove('show');
      $('dirMask').classList.remove('show');
      stopQrTimer();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      const tag = document.activeElement.tagName;
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) $('input').focus();
    }
  });
}

/* ============================================================
   启动
   ============================================================ */

async function boot() {
  bind();
  updateInputCount();
  renderRecent();

  // 入场动画：rAF 为主，setTimeout 兜底。
  // 标签页在后台时 rAF 会被浏览器节流甚至不执行，没有兜底会导致内容永远停在 opacity:0。
  const markReady = () => document.body.classList.add('ready');
  requestAnimationFrame(markReady);
  setTimeout(markReady, 120);

  // 支持 ?url=xxx 直接解析，可重复传参实现一次多条
  const presets = new URLSearchParams(location.search).getAll('url');
  if (presets.length) {
    $('input').value = presets.filter(Boolean).join('\n');
    updateInputCount();
    autoGrow();
    doParse();
  } else {
    $('input').focus();
  }

  try {
    const cfg = await api('/api/config');
    applyAccount(cfg.user || null);
    state.downloadDir = cfg.downloadDir || '';
    $('btnOpenFolder').title = state.downloadDir || '打开下载文件夹';
    renderHdNote(cfg);

    if (cfg.demo) enableDemo();
    else if (!cfg.hasCookie) {
      notice('当前是访客模式，最高 720P。点右上角「游客」扫码登录可解锁高画质。', 'info', 8000);
    }
  } catch {
    notice('连不上本地服务，请确认程序窗口还在运行', 'error');
  }

  pollTasks();
}

boot();
