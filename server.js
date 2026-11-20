#!/usr/bin/env node
'use strict';

/**
 * 哔哩提取器 · 本地服务
 * ------------------------------------------------------------
 * 零第三方依赖，只用 Node 内置模块。
 *
 * 为什么必须有本地服务？
 *   B 站视频流有防盗链，请求必须带 Referer: https://www.bilibili.com，
 *   浏览器无法为 <video>/fetch 自定义 Referer，所以下载动作只能由后端代理。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

/* ============================================================
 * 本机访问防护
 * ------------------------------------------------------------
 * 这个服务能读磁盘、能改设置、还存着 B 站登录态，所以只允许
 * 「真的在本机、真的从本页面发起」的请求：
 *   1. Host 必须是 127.0.0.1 / localhost —— 挡住 DNS 重绑定
 *   2. 跨站 Origin / Sec-Fetch-Site 的写操作直接拒绝 —— 挡住 CSRF
 *   3. 统一安全响应头 + 严格 CSP —— 挡住被注入的外部脚本
 *   4. 简单限流 —— 脚本跑飞时不会把 B 站接口打爆
 * ============================================================ */

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 从 Host 头里取出主机名（去掉端口，兼容 IPv6 的方括号写法） */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(0, end + 1) : raw;
  }
  return raw.split(':')[0];
}

function isLocalHostHeader(hostHeader) {
  return LOCAL_HOSTNAMES.has(hostnameOf(hostHeader));
}

function isLocalOrigin(origin) {
  try {
    const u = new URL(String(origin));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

/* ============================================================
 * 演示模式（部署到公网创空间时使用）
 * ------------------------------------------------------------
 * 本程序原本是「本机工具」：只监听 127.0.0.1、能写盘、存登录态。
 * 放到公网容器里必须收住三件事，否则要么跑不起来，要么变成
 * 一台任何人都能用的下载代理：
 *   1. 绑定 0.0.0.0 并放开 Host 校验（域名由平台分配，无法预知）
 *   2. 关闭登录与设置写入 —— 绝不让别人的凭证落到服务器上
 *   3. 关闭写盘、登录与设置接口 —— 绝不让别人的凭证或文件落到服务器上
 * 在线版只保留「解析 + 受控下载」：下载改为服务端取流、浏览器直收，
 * 不写服务器磁盘；视频限访客可见的 720P 及以下，音频 / 封面同样放行。
 * ============================================================ */

const DEMO = process.env.STUDIO_DEMO === '1';

/** 会写服务器磁盘的接口，演示模式一律拒绝；在线下载走独立的 /api/demo/download */
const DEMO_BLOCKED = [
  '/api/download',
  '/api/login',
  '/api/logout',
  '/api/open-folder',
  '/api/fs/',
  '/api/cancel',
];

function demoBlocked(pathname) {
  return DEMO_BLOCKED.some((p) => pathname === p || pathname.startsWith(p));
}

/* ---- 在线下载：流式代理，不落盘、不收凭证 ---- */
const DEMO_DOWNLOAD_PATH = '/api/demo/download';
const DEMO_MAX_BYTES = 500 * 1024 * 1024; // 单个文件上限
const DEMO_MAX_ACTIVE = 2; // 全局同时取流数，保护创空间带宽
const DEMO_LIMIT_WINDOW = 60 * 1000;
const DEMO_LIMIT_COUNT = 20; // 每 IP 每分钟最多 20 次
const demoDownloadBuckets = new Map();
let demoDownloadActive = 0;

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'local';
}

function demoDownloadLimited(ip) {
  const now = Date.now();
  const bucket = demoDownloadBuckets.get(ip);
  if (!bucket || now - bucket.start > DEMO_LIMIT_WINDOW) {
    demoDownloadBuckets.set(ip, { start: now, count: 1 });
    if (demoDownloadBuckets.size > 128) {
      for (const [key, v] of demoDownloadBuckets) {
        if (now - v.start > DEMO_LIMIT_WINDOW) demoDownloadBuckets.delete(key);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > DEMO_LIMIT_COUNT;
}

/** 返回 null 表示放行，否则返回拒绝原因 */
function rejectReason(req) {
  // 演示模式：域名由平台分配，Host 无法预先枚举，交给 Origin 校验兜底
  if (!DEMO && !isLocalHostHeader(req.headers.host)) return 'host';

  const origin = req.headers.origin;
  if (origin) {
    if (DEMO) {
      // 只接受「同源」请求（页面自己发起的）
      try {
        const o = new URL(origin);
        const h = hostnameOf(req.headers.host);
        if (h && o.hostname !== h) return 'origin';
      } catch {
        return 'origin';
      }
    } else if (!isLocalOrigin(origin)) {
      return 'origin';
    }
  }

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return 'site';
  }

  return null;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
};

// 本机版禁止被任何页面嵌套；演示版需要允许魔搭的 iframe 嵌入
if (!DEMO) SECURITY_HEADERS['X-Frame-Options'] = 'DENY';

/** 页面能加载什么，由这里一次说清 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.hdslb.com https://*.biliimg.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  // 演示模式挂在魔搭的 iframe 里，其余场景一律不许被嵌套
  DEMO ? "frame-ancestors 'self' https://modelscope.cn https://*.modelscope.cn https://*.ms.show" : "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/* ---- 简单限流：10 秒 240 次，本机单客户端足够用 ---- */
const RATE_LIMIT = 240;
const RATE_WINDOW = 10 * 1000;
const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.start > RATE_WINDOW) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }

  bucket.count += 1;

  // 本机只会有一个客户端，这里只是防止 Map 无限增长
  if (rateBuckets.size > 64) {
    for (const [key, v] of rateBuckets) {
      if (now - v.start > RATE_WINDOW) rateBuckets.delete(key);
    }
  }

  return bucket.count > RATE_LIMIT;
}

/** 安全状态快照，给设置面板展示用 */
const SECURITY_STATE = {
  configPerm: 'unknown', // restricted | unknown
  credentialEncrypted: false,
};

/**
 * 二维码生成库按需加载。
 * 万一用户把项目拷到没装 node_modules 的地方，服务仍能启动，只是登录不可用。
 */
let QRCodeLib = null;
function getQRCodeLib() {
  if (QRCodeLib !== null) return QRCodeLib;
  try {
    QRCodeLib = require('qrcode');
  } catch {
    QRCodeLib = false;
  }
  return QRCodeLib;
}

/**
 * ffmpeg 用于合并 DASH 分离的音视频流。
 * 没有它就只能下 720P 的合并流（DURL），所以启动时先探一下。
 */
let FFMPEG_PATH = '';

function initFFmpeg() {
  // 1) 优先用项目自带的二进制
  try {
    const f = require('@ffmpeg-installer/ffmpeg');
    if (f && f.path && fs.existsSync(f.path)) {
      FFMPEG_PATH = f.path;
      return;
    }
  } catch {
    /* 没装就继续找系统里的 */
  }

  // 2) 退回系统 PATH 里的 ffmpeg
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (p && fs.existsSync(p)) {
          FFMPEG_PATH = p;
          return;
        }
      } catch {
        /* ignore */
      }
    }
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// 桌面版跑在 exe 的临时解压目录里，配置和下载必须落到用户目录，退出后才不会丢
const PACKAGED = process.env.ELECTRON_RUN_AS_NODE === '1' || process.env.BILI_APP_IPC === '1';
const DATA_ROOT = PACKAGED ? path.join(os.homedir(), '.bili-extractor') : ROOT;
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const DEFAULT_DOWNLOAD_DIR = path.join(DATA_ROOT, 'downloads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ============================================================
 * 配置
 * ============================================================ */

const defaultConfig = {
  downloadDir: DEFAULT_DOWNLOAD_DIR,
  cookie: '', // B 站登录凭证（SESSDATA 等），扫码登录后自动写入
  user: null, // { mid, name, face } 登录用户快照
};

let config = { ...defaultConfig };

/* ============================================================
 * 登录凭证保护
 * ------------------------------------------------------------
 * Cookie 等于账号权限，不能明文躺在 config.json 里：
 *   - 用 AES-256-GCM 加密后落盘
 *   - 密钥由「本机主机名 + 当前用户名」派生，文件拷到别的机器解不开
 *   - 附带收紧文件权限（Unix chmod 600 / Windows icacls）
 * 说明：这是本机防护，能挡住随手翻看和误传文件，不能替代系统级密钥管理。
 * ============================================================ */

const SECRET_SALT = 'bili-extractor::credential::v1';

function deriveKey() {
  let user = '';
  try {
    user = os.userInfo().username || '';
  } catch {
    user = process.env.USERNAME || process.env.USER || '';
  }
  const seed = `${os.hostname()}|${user}|bili-extractor`;
  return crypto.pbkdf2Sync(seed, SECRET_SALT, 120000, 32, 'sha256');
}

/** 加密成 base64(iv + tag + ciphertext) */
function encryptSecret(plain) {
  if (!plain) return '';
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  } catch {
    return '';
  }
}

function decryptSecret(payload) {
  if (!payload) return '';
  try {
    const buf = Buffer.from(String(payload), 'base64');
    if (buf.length < 29) return '';
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 换机器、换用户、文件被改动都会走到这里
    return '';
  }
}

/** 尽量把配置文件设成「只有当前用户可读写」 */
function tightenConfigPermissions() {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || '';
      if (!user) return;
      execFile(
        'icacls',
        [CONFIG_PATH, '/inheritance:r', '/grant:r', `${user}:F`],
        { windowsHide: true },
        (err) => {
          SECURITY_STATE.configPerm = err ? 'unknown' : 'restricted';
        }
      );
    } else {
      fs.chmodSync(CONFIG_PATH, 0o600);
      SECURITY_STATE.configPerm = 'restricted';
    }
  } catch {
    SECURITY_STATE.configPerm = 'unknown';
    /* 权限收紧失败不影响主流程 */
  }
}

let needsSecretMigration = false;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const saved = JSON.parse(raw);

    config = { ...defaultConfig, ...saved };

    // 密文优先；兼容早期明文 cookie 的旧文件，并在启动时自动迁移成密文
    config.cookie = decryptSecret(saved.cookieEnc) || saved.cookie || '';
    delete config.cookieEnc;

    SECURITY_STATE.credentialEncrypted = Boolean(saved.cookieEnc);

    if (saved.cookie && !saved.cookieEnc) needsSecretMigration = true;

    if (!config.downloadDir) config.downloadDir = DEFAULT_DOWNLOAD_DIR;
  } catch {
    /* 首次运行没有配置文件，用默认值 */
  }
  if (!config.downloadDir) config.downloadDir = DEFAULT_DOWNLOAD_DIR;
}

async function saveConfig() {
  // 落盘永不写明文 cookie，只写密文
  const out = {
    downloadDir: config.downloadDir,
    cookieEnc: encryptSecret(config.cookie || ''),
    user: config.user || null,
  };
  await fsp.mkdir(DATA_ROOT, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf8');
  tightenConfigPermissions();
}

function downloadDir() {
  return config.downloadDir || DEFAULT_DOWNLOAD_DIR;
}

async function ensureDownloadDir() {
  await fsp.mkdir(downloadDir(), { recursive: true });
}

/* ============================================================
 * HTTP 请求工具
 * ============================================================ */

/**
 * GET 请求，自动跟随重定向，返回响应流。
 */
function requestGet(urlStr, headers = {}, redirects = 0, guard = null) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error('非法地址：' + urlStr));
    }
    // 每一跳都要过校验，防止 302 把请求带去内网地址
    if (guard && !guard(u)) {
      return reject(new Error('该地址不在允许范围内'));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      u,
      {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
      },
      (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && redirects < 6) {
          res.resume();
          const next = new URL(loc, urlStr).toString();
          resolve(requestGet(next, headers, redirects + 1, guard));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('网络请求超时')));
  });
}

/** 请求并读取为文本 */
async function fetchText(urlStr, headers = {}) {
  const res = await requestGet(urlStr, headers);
  const chunks = [];
  for await (const c of res) {
    chunks.push(c);
    if (chunks.reduce((a, b) => a + b.length, 0) > 8 * 1024 * 1024) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 请求并解析 JSON */
async function fetchJSON(urlStr, headers = {}) {
  const txt = await fetchText(urlStr, headers);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error('接口返回的不是 JSON：' + txt.slice(0, 120));
  }
}

/* ============================================================
 * B 站接口封装
 * ============================================================ */

/** 服务启动时获取的访客 cookie（buvid3 / buvid4），可显著降低风控概率 */
let guestCookie = '';

async function initGuestCookie() {
  try {
    const j = await fetchJSON('https://api.bilibili.com/x/frontend/finger/spi');
    if (j && j.code === 0 && j.data) {
      const parts = [];
      if (j.data.b_3) parts.push('buvid3=' + j.data.b_3);
      if (j.data.b_4) parts.push('buvid4=' + j.data.b_4);
      guestCookie = parts.join('; ');
    }
  } catch {
    /* 失败不致命，继续用空 cookie 请求 */
  }
}

function biliHeaders() {
  const cookies = [guestCookie, config.cookie].filter(Boolean).join('; ');
  const h = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
  };
  if (cookies) h.Cookie = cookies;
  return h;
}

async function biliApi(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = 'https://api.bilibili.com' + pathname + (qs ? '?' + qs : '');
  const j = await fetchJSON(url, biliHeaders());
  if (j.code !== 0) {
    const msg = j.message || '未知错误';
    const hint =
      j.code === -404 || j.code === -400
        ? '（视频不存在、已被删除，或 BV 号有误）'
        : j.code === -403
        ? '（访问被拒绝，可能需要登录）'
        : j.code === -352
        ? '（触发风控，请稍后重试或填写 Cookie）'
        : j.code === 87007
        ? '（该视频为充电专属）'
        : '';
    throw new Error(`B站接口错误 ${j.code}：${msg}${hint}`);
  }
  return j.data;
}

/* ============================================================
 * 扫码登录
 * ============================================================ */

/** 申请登录二维码，返回 key 与可直接放进 <img> 的 PNG DataURI */
async function createLoginQr() {
  const j = await fetchJSON(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  );
  if (j.code !== 0 || !j.data) throw new Error('申请登录二维码失败');

  const { url, qrcode_key } = j.data;
  const lib = getQRCodeLib();
  if (!lib) throw new Error('缺少二维码组件，请在项目目录执行 npm install 后再试');

  // 二维码必须是浅底深码；margin 为静区（白边）宽度，规范建议 2–4 个模块
  const qrImg = await lib.toDataURL(url, {
    margin: 2,
    width: 260,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b0b0c', light: '#ffffff' },
  });

  return { qrcodeKey: qrcode_key, qrImg, loginUrl: url };
}

/** 把 Set-Cookie 数组解析成键值表 */
function parseSetCookies(arr) {
  const map = {};
  for (const line of arr || []) {
    const first = String(line).split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) {
      const k = first.slice(0, idx).trim();
      const v = first.slice(idx + 1).trim();
      if (k) map[k] = v;
    }
  }
  return map;
}

/** 查询登录状态（供启动时判断 Cookie 是否仍然有效） */
async function fetchLoginUser() {
  if (!config.cookie) return null;
  try {
    const j = await fetchJSON('https://api.bilibili.com/x/web-interface/nav', biliHeaders());
    if (j.code === 0 && j.data && j.data.isLogin) {
      return {
        mid: j.data.mid,
        name: j.data.uname,
        face: hdCover(j.data.face || ''),
        level: j.data.level_info ? j.data.level_info.current_level : 0,
        vip: Boolean(j.data.vipStatus || (j.data.vip && j.data.vip.status)),
      };
    }
  } catch {
    /* 网络异常时按未登录处理 */
  }
  return null;
}

/**
 * 轮询扫码结果。
 * data.code: 86101 未扫码 / 86090 已扫码待确认 / 86038 已失效 / 0 成功
 */
async function pollLogin(key) {
  const url =
    'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' +
    encodeURIComponent(key);

  const res = await requestGet(url, {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
  });

  const chunks = [];
  for await (const c of res) chunks.push(c);
  let j;
  try {
    j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('登录状态返回异常');
  }

  if (j.code !== 0 || !j.data) throw new Error(j.message || '登录状态查询失败');

  const sc = j.data.code;

  if (sc === 86101) return { status: 'waiting' };
  if (sc === 86090) return { status: 'scanned' };
  if (sc === 86038) return { status: 'expired' };

  if (sc === 0) {
    /* 登录成功：Cookie 在响应头里 */
    const cookies = parseSetCookies(res.headers['set-cookie']);
    if (!cookies.SESSDATA) return { status: 'error', message: '未能获取登录凭证' };

    config.cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    config.user = null;
    await saveConfig();

    // 再查一次用户信息，顺便验证 Cookie 真的可用
    const user = await fetchLoginUser();
    if (user) {
      config.user = user;
      await saveConfig();
    }

    return { status: 'ok', user };
  }

  return { status: 'waiting' };
}

/** 退出登录 */
async function logout() {
  config.cookie = '';
  config.user = null;
  await saveConfig();
}

/* ============================================================
 * 链接解析
 * ============================================================ */

function parseInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入 B 站链接或 BV 号');

  let p = 1;
  const mP = raw.match(/[?&]p=(\d+)/i);
  if (mP) p = Math.max(1, parseInt(mP[1], 10));

  let m = raw.match(/BV([0-9A-Za-z]{10})/);
  if (m) return { kind: 'video', bvid: 'BV' + m[1], p };

  m = raw.match(/b23\.tv\/([A-Za-z0-9]+)/i);
  if (m) return { kind: 'short', code: m[1], p };

  m = raw.match(/[?&/]av(\d+)/i) || raw.match(/^av(\d+)$/i);
  if (m) return { kind: 'video', aid: m[1], p };

  m = raw.match(/ep(\d+)/i);
  if (m) return { kind: 'ep', id: m[1] };

  m = raw.match(/ss(\d+)/i);
  if (m) return { kind: 'ss', id: m[1] };

  if (/^\d+$/.test(raw)) return { kind: 'video', aid: raw, p };

  throw new Error('无法识别的链接。支持：BV 号、av 号、视频链接、b23.tv 短链、番剧 ep/ss');
}

/** 展开 b23.tv 短链，拿到真实地址 */
async function resolveShort(code) {
  const res = await new Promise((resolve, reject) => {
    const req = https.get(
      'https://b23.tv/' + code,
      { headers: { 'User-Agent': UA }, timeout: 15000 },
      resolve
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('短链解析超时')));
  });
  const loc = res.headers.location || '';
  res.resume();
  if (!loc) throw new Error('短链解析失败，请直接粘贴完整视频链接');
  return loc;
}

/** 只允许 B 站自己的图片域名，避免封面代理被当成任意地址的跳板 */
function isBiliImageHost(hostname) {
  return /(^|\.)(hdslb\.com|biliimg\.com|bilibili\.com)$/i.test(String(hostname || ''));
}

/** 视频/音频流域名：B 站 CDN 会跳到这些域名，逐跳都要校验 */
function isBiliStreamHost(hostname) {
  return /(^|\.)(bilivideo\.com|bilivideo\.cn|biliapi\.net|biliapi\.com|bilibili\.com|bilibili\.cn|hdslb\.com|biliimg\.com|edge\.mountaintoys\.cn)$/i.test(
    String(hostname || '')
  );
}

function demoStreamGuard(u) {
  return (
    (u.protocol === 'https:' || u.protocol === 'http:') && isBiliStreamHost(u.hostname)
  );
}

function checkDemoStreamUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!demoStreamGuard(u)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 封面图取原图：去掉 B 站 CDN 的 @ 缩放参数 */
function hdCover(url) {
  if (!url) return '';
  return String(url).replace(/^http:/, 'https:').split('@')[0];
}

/** 格式化时长（秒 → mm:ss / hh:mm:ss） */
function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/**
 * UP 主粉丝数。
 * 单独一个接口，游客态也能拿到；批量解析时同一个 UP 会被反复问到，
 * 所以做 30 分钟内存缓存，避免重复请求触发风控。
 */
const fansCache = new Map();
const FANS_TTL = 30 * 60 * 1000;

async function getFansCount(mid) {
  const id = Number(mid) || 0;
  if (!id) return null;

  const hit = fansCache.get(id);
  if (hit && Date.now() - hit.ts < FANS_TTL) return hit.fans;

  try {
    const j = await fetchJSON(
      `https://api.bilibili.com/x/relation/stat?vmid=${id}`,
      biliHeaders()
    );
    const fans = j && j.code === 0 && j.data ? Number(j.data.follower) : NaN;
    if (!Number.isFinite(fans)) return null;
    fansCache.set(id, { fans, ts: Date.now() });
    return fans;
  } catch {
    // 粉丝数只是锦上添花，拿不到就别让整个解析失败
    return null;
  }
}

/** 主解析入口 */
async function resolveVideo(input) {
  const parsed = parseInput(input);

  let target = parsed;

  if (parsed.kind === 'short') {
    const real = await resolveShort(parsed.code);
    target = parseInput(real);
    target.p = parsed.p || target.p;
  }

  /* ---------- 番剧 / 剧集 ---------- */
  if (target.kind === 'ep' || target.kind === 'ss') {
    const params =
      target.kind === 'ep' ? { ep_id: target.id } : { season_id: target.id };
    const season = await biliApi('/pgc/view/web/season', params);
    const eps = season.episodes || [];
    if (!eps.length) throw new Error('该番剧没有可解析的剧集');

    const first = eps[0];
    return {
      type: 'bangumi',
      title: season.season_title || season.title || '未命名番剧',
      cover: hdCover(season.cover),
      desc: season.evaluate || '',
      owner: { name: '番剧', face: '', mid: 0, fans: null },
      stat: {},
      duration: 0,
      pubdate: 0,
      bvid: first.bvid || '',
      aid: first.aid || 0,
      isBangumi: true,
      pages: eps.map((e, i) => ({
        cid: e.cid,
        index: i + 1,
        part: e.title || `第 ${i + 1} 话`,
        duration: e.duration ? Math.round(e.duration / 1000) : 0,
        bvid: e.bvid || '',
        aid: e.aid || 0,
        epId: e.id,
      })),
      currentPage: 1,
    };
  }

  /* ---------- 普通视频（BV / av） ---------- */
  const params = target.bvid ? { bvid: target.bvid } : { aid: target.aid };
  const v = await biliApi('/x/web-interface/view', params);

  const pages = (v.pages || []).map((pg, i) => ({
    cid: pg.cid,
    index: pg.page || i + 1,
    part: pg.part || `P${i + 1}`,
    duration: pg.duration || 0,
    bvid: v.bvid,
    aid: v.aid,
  }));

  const cur = Math.min(Math.max(1, target.p || 1), pages.length || 1);

  const ownerMid = (v.owner && v.owner.mid) || 0;
  const fans = await getFansCount(ownerMid);

  return {
    type: 'video',
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    cover: hdCover(v.pic),
    desc: v.desc || '',
    tname: v.tname || '',
    owner: {
      name: (v.owner && v.owner.name) || '未知 UP',
      face: hdCover((v.owner && v.owner.face) || ''),
      mid: ownerMid,
      fans, // null 表示取不到，前端不显示
    },
    stat: v.stat || {},
    duration: v.duration || 0,
    pubdate: v.pubdate || 0,
    isBangumi: false,
    pages,
    currentPage: cur,
  };
}

/* ============================================================
 * 清晰度
 * ============================================================ */

const QN_LABEL = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
};

/**
 * 探测某分 P 真实可用的清晰度。
 * 关键点：DURL 模式（fnval=1）下返回的 accept_quality 是「真实可用」列表，
 * 而 DASH 模式返回的是「理论上限」，游客会看到 1080P 却下不动。所以必须用 DURL 探测。
 */
async function probeQualities({ bvid, cid, aid, epId }) {
  const params = { cid, qn: 127, fnval: 1, fourk: 1 };
  if (bvid) params.bvid = bvid;
  if (aid && !bvid) params.avid = aid;
  if (epId) params.ep_id = epId;

  const endpoint = epId ? '/pgc/player/web/playurl' : '/x/player/playurl';
  const d = await biliApi(endpoint, params);

  const accept = d.accept_quality || (d.quality ? [d.quality] : []);
  const desc = d.accept_description || [];

  const list = accept.map((qn, i) => ({
    qn,
    label: desc[i] || QN_LABEL[qn] || `清晰度 ${qn}`,
    isDefault: qn === d.quality,
    mode: 'durl',
  }));

  /**
   * DURL 通道最高只到 720P。1080P 及以上必须是 DASH 分离流，
   * 且需要登录 Cookie + 本地 ffmpeg 才能合并，两个条件都在才把它们列出来。
   */
  if (FFMPEG_PATH && config.cookie) {
    try {
      const dp = { ...params, fnval: 4048 };
      const dd = await biliApi(endpoint, dp);
      const dash = dd.dash || {};
      const streams = dash.video || [];

      if (streams.length) {
        const ids = [...new Set(streams.map((s) => Number(s.id)))]
          .filter((id) => id > 64) // 720P 以下继续走 DURL，没必要合并
          .sort((a, b) => b - a);

        for (const id of ids) {
          if (list.some((x) => x.qn === id)) continue;
          list.push({
            qn: id,
            label: QN_LABEL[id] || `${id}`,
            isDefault: false,
            mode: 'dash',
          });
        }

        // 按清晰度从高到低排序
        list.sort((a, b) => b.qn - a.qn);
      }
    } catch {
      /* 探测失败就只给 DURL 档位，不影响使用 */
    }
  }

  return list;
}

/* ---- 音频轨 ---- */

const AUDIO_LABEL = {
  30216: '64K 流畅',
  30232: '132K 标准',
  30280: '192K 高品质',
  30250: '杜比全景声',
  30251: 'Hi-Res 无损',
};

/**
 * 探测可用音频轨。
 * 音频在 DASH 里独立成轨，不走 DURL，所以要单独请求 fnval=4048。
 * 三档常规音质游客即可获取，杜比与 Hi-Res 需要大会员。
 */
async function probeAudio({ bvid, cid, aid, epId }) {
  const params = { cid, fnval: 4048, fourk: 1 };
  if (bvid) params.bvid = bvid;
  if (aid && !bvid) params.avid = aid;
  if (epId) params.ep_id = epId;

  const endpoint = epId ? '/pgc/player/web/playurl' : '/x/player/playurl';
  const d = await biliApi(endpoint, params);
  const dash = d.dash || {};

  const list = [...(dash.audio || [])];
  if (dash.dolby && dash.dolby.audio) list.push(dash.dolby.audio);
  if (dash.flac && dash.flac.audio) list.push(dash.flac.audio);

  if (!list.length) return [];

  return list
    .sort((a, b) => b.bandwidth - a.bandwidth)
    .map((a) => ({
      id: a.id,
      label: AUDIO_LABEL[a.id] || `${Math.round(a.bandwidth / 1000)}K`,
      bandwidth: a.bandwidth,
    }));
}

/* ============================================================
 * 下载任务
 * ============================================================ */

const tasks = new Map();
let taskSeq = 0;

// 终态任务才允许被回收；活跃任务（queued/resolving/downloading/merging）永不自动删除。
const TASK_TERMINAL = new Set(['done', 'error', 'canceled']);
const MAX_TASKS = 80;

function newTask(meta) {
  const id = `t${++taskSeq}_${Date.now().toString(36)}`;
  const task = {
    id,
    // pending | queued | resolving | downloading | merging | done | error | canceled
    status: 'pending',
    downloaded: 0,
    total: 0,
    speed: 0,
    error: '',
    startedAt: Date.now(),
    finishedAt: 0,
    _res: null, // 进行中的下载流，取消时用来中断
    _ffmpeg: null, // 进行中的 ffmpeg 子进程，取消时用来终止
    ...meta,
  };
  tasks.set(id, task);
  pruneTasks();
  return task;
}

/** 超过上限时只按「终态 + 最旧」回收，活跃任务一条都不动 */
function pruneTasks() {
  if (tasks.size <= MAX_TASKS) return;
  const terminal = [...tasks.values()]
    .filter((t) => TASK_TERMINAL.has(t.status))
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const t of terminal) {
    if (tasks.size <= MAX_TASKS) break;
    tasks.delete(t.id);
  }
}

/** 已取消就抛错，阻止后续流程把状态又改回 downloading/done */
function ensureActive(task) {
  if (task.status === 'canceled') {
    const e = new Error('已取消');
    e.canceled = true;
    throw e;
  }
}

/** 标记任务为已取消，并尽力中断它正在做的事 */
function cancelTask(t) {
  if (!t || TASK_TERMINAL.has(t.status)) return false;

  t.status = 'canceled';
  t.finishedAt = Date.now();
  t.speed = 0;

  // 还在等待队列里：直接摘掉，避免之后又被启动
  const qi = downloadQueue.findIndex((x) => x.taskId === t.id);
  if (qi >= 0) {
    const [item] = downloadQueue.splice(qi, 1);
    try { item.resolve(); } catch {}
  }

  // 中断进行中的下载流
  if (t._res) {
    try { t._res.destroy(); } catch {}
  }

  // 终止 ffmpeg 合并进程
  if (t._ffmpeg) {
    try { t._ffmpeg.kill('SIGKILL'); } catch {}
  }

  // 释放文件名预留，避免长期运行后集合无限增长
  if (t.filePath) reservedPaths.delete(t.filePath);

  return true;
}

/* ---- 并发闸门：批量下载时最多同时跑 3 个，避免触发 B 站风控 ---- */

const MAX_ACTIVE_DOWNLOADS = 3;
let activeDownloads = 0;
const downloadQueue = [];

/** 把一段下载流程排进队列，返回 Promise（流程自身负责写 task 状态）。
 *  第一个参数是任务对象：取消时按 task.id 把还在排队的任务直接摘掉。 */
function enqueueDownload(task, runFn) {
  return new Promise((resolve) => {
    downloadQueue.push({ runFn, resolve, taskId: task && task.id });
    drainQueue();
  });
}

function drainQueue() {
  while (activeDownloads < MAX_ACTIVE_DOWNLOADS && downloadQueue.length) {
    const { runFn, resolve } = downloadQueue.shift();
    activeDownloads++;
    Promise.resolve()
      .then(runFn)
      .catch((e) => console.error('[下载异常]', e.message))
      .finally(() => {
        activeDownloads--;
        resolve();
        drainQueue();
      });
  }
}

function queueStatus() {
  return { active: activeDownloads, waiting: downloadQueue.length };
}

function safeName(s) {
  return String(s || 'untitled')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100) || 'untitled';
}

/**
 * 目标文件重名时自动加序号。
 * 并发下载时多个任务可能同时判定「文件不存在」而抢到同一个名字，
 * 所以除了查磁盘，还要查一张已预留名单。
 */
const reservedPaths = new Set();

async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const extLower = String(ext).toLowerCase();

  let candidate = path.join(dir, filename);
  let i = 1;

  while (true) {
    if (!reservedPaths.has(candidate)) {
      let onDisk = false;
      try {
        await fsp.access(candidate);
        onDisk = true;
      } catch {
        onDisk = false;
      }
      if (!onDisk) break;
    }
    candidate = path.join(dir, `${base} (${i})${extLower}`);
    i++;
    if (i > 999) break;
  }

  reservedPaths.add(candidate);
  return candidate;
}

/**
 * 把远端流写入本地文件。
 * 先写 .part 临时文件，完成后改名，避免中断留下半截文件。
 */
function streamToFile(urlStr, filePath, task, onDone) {
  return new Promise((resolve, reject) => {
    const tmp = filePath + '.part';
    const out = fs.createWriteStream(tmp);
    let lastBytes = 0;
    let lastTime = Date.now();

    const timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.2) {
        task.speed = Math.max(0, (task.downloaded - lastBytes) / dt);
        lastBytes = task.downloaded;
        lastTime = now;
      }
    }, 600);

    const cleanup = (err) => {
      clearInterval(timer);
      task.speed = 0;
      task._res = null;
      try {
        out.close();
      } catch {}
      fsp.unlink(tmp).catch(() => {});
      reject(err);
    };

    requestGet(urlStr, {
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    })
      .then((res) => {
        if (res.statusCode >= 400) {
          res.resume();
          return cleanup(new Error(`下载失败，HTTP ${res.statusCode}`));
        }
        // DASH 分段下载时会预先设好总大小（视频+音频），这里不要覆盖
        const len = parseInt(res.headers['content-length'] || '0', 10) || 0;
        if (len && !task.total) task.total = len;
        task._res = res; // 取消时可立即中断这条流
        res.on('data', (chunk) => {
          task.downloaded += chunk.length;
          if (task.status === 'canceled') {
            res.destroy();
            return;
          }
        });
        res.on('error', cleanup);
        out.on('error', cleanup);
        out.on('finish', () => {
          clearInterval(timer);
          task.speed = 0;
          task._res = null;
          // 用户取消时不要留下半截文件
          if (task.status === 'canceled') {
            fsp.unlink(tmp).catch(() => {});
            return reject(new Error('已取消'));
          }
          fs.rename(tmp, filePath, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
        res.pipe(out);
      })
      .catch(cleanup);
  });
}

/* ============================================================
 * 业务动作
 * ============================================================ */

/* ---- DASH 与 ffmpeg ---- */

/** 在候选视频流里挑一条：优先 H.264（兼容性最好），其次 HEVC / AV1 */
function pickVideoStream(streams, qn) {
  const cand = (streams || []).filter((s) => Number(s.id) === Number(qn));
  if (!cand.length) return null;

  const order = ['avc1', 'hvc1', 'hev1', 'av01'];
  for (const codec of order) {
    const hit = cand.find((s) => String(s.codecs || '').startsWith(codec));
    if (hit) return hit;
  }
  return cand.sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

/** 探测远端文件大小（用于把两段流的进度合并成一条） */
async function headSize(urlStr, guard = null) {
  try {
    const res = await requestGet(
      urlStr,
      {
        Referer: 'https://www.bilibili.com/',
        Range: 'bytes=0-0',
      },
      0,
      guard
    );
    const cr = res.headers['content-range'] || '';
    const m = String(cr).match(/\/(\d+)\s*$/);
    res.resume();
    if (m) return parseInt(m[1], 10) || 0;
    return parseInt(res.headers['content-length'] || '0', 10) || 0;
  } catch {
    return 0;
  }
}

/** 用 ffmpeg 把分离的音视频流无损封装成一个 mp4（-c copy，不重新编码） */
function mergeStreams(videoPath, audioPath, outPath, task) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_PATH) {
      return reject(new Error('未找到 ffmpeg，无法合并高清音视频'));
    }

    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath,
    ];

    const child = execFile(
      FFMPEG_PATH,
      args,
      { timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (task) task._ffmpeg = null;
        if (err) {
          // 用户取消导致的中断不算失败
          if (task && task.status === 'canceled') return reject(new Error('已取消'));
          const tail = String(stderr || err.message)
            .split('\n')
            .filter(Boolean)
            .slice(-3)
            .join(' ');
          return reject(new Error('合并失败：' + tail));
        }
        resolve();
      }
    );
    // 注册子进程，取消时直接 kill
    if (task) task._ffmpeg = child;
  });
}

/**
 * 下载重试：网络抖动时自动再来一次。
 * shouldStop 用于「用户主动取消」这类不该重试的情况。
 */
async function withRetry(fn, { times = 2, shouldStop } = {}) {
  let lastErr;

  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (shouldStop && shouldStop()) throw e;
      if (i < times - 1) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }

  throw lastErr;
}

/**
 * 启动视频下载。
 * 前端已解析过视频，直接带 bvid/aid/epId/cid 过来，这里不再重复调 view 接口。
 * 「取地址 + 下载」整段流程进并发队列，批量下载时不会瞬间打满接口。
 */
async function startVideoDownload(opts) {
  const { input, bvid, aid, epId, cid, qn, title, part, index, pageCount } = opts || {};
  if (!cid) throw new Error('缺少分 P 信息，请先解析视频');
  if (!bvid && !aid && !epId) throw new Error('缺少视频标识，请重新解析');

  await ensureDownloadDir();

  const task = newTask({
    type: 'video',
    title: title || 'bilibili 视频',
    filename: '',
    filePath: '',
    quality: QN_LABEL[qn] || `${qn}`,
    status: 'queued',
  });
  task.retry = { kind: 'video', payload: { ...(opts || {}) } };

  enqueueDownload(task, async () => {
    try {
      task.status = 'resolving';

      const baseParams = { cid };
      if (epId) baseParams.ep_id = epId;
      else if (bvid) baseParams.bvid = bvid;
      else baseParams.avid = aid;

      const endpoint = epId ? '/pgc/player/web/playurl' : '/x/player/playurl';
      const wantQn = Number(qn) || 64;

      // 1080P 及以上只有 DASH 分离流，必须同时具备登录 Cookie 与本地 ffmpeg
      const useDash = wantQn > 64 && Boolean(FFMPEG_PATH) && Boolean(config.cookie);

      const baseTitle = safeName(title || 'bilibili 视频');
      const partSuffix =
        pageCount > 1 ? ` - P${index || 1} ${safeName(part || '')}`.trimEnd() : '';

      if (useDash) {
        /* ---------- 高清：DASH 分离流 + ffmpeg 无损封装 ---------- */
        const d = await biliApi(endpoint, {
          ...baseParams,
          qn: wantQn,
          fnval: 4048,
          fourk: 1,
        });
        const dash = d.dash || {};

        const v = pickVideoStream(dash.video, wantQn);
        if (!v) throw new Error('该清晰度暂不可用，换一档试试');

        const audios = [...(dash.audio || [])].sort((a, b) => b.bandwidth - a.bandwidth);
        const a = audios[0];
        if (!a) throw new Error('未取到音频流');

        const vUrl = v.baseUrl || v.base_url;
        const aUrl = a.baseUrl || a.base_url;
        if (!vUrl || !aUrl) throw new Error('流地址为空，请稍后重试');

        const qLabel = QN_LABEL[v.id] || `${v.id}`;
        const filePath = await uniquePath(
          downloadDir(),
          `${baseTitle}${partSuffix} [${qLabel}].mp4`
        );

        task.filename = path.basename(filePath);
        task.filePath = filePath;
        task.quality = qLabel;

        const tmpV = filePath + '.v.part';
        const tmpA = filePath + '.a.part';

        try {
          ensureActive(task);
          task.status = 'downloading';

          // 先算出两段流的总大小，进度条才不会在第二段跳回去
          const total = (await headSize(vUrl)) + (await headSize(aUrl));
          if (total) task.total = total;

          await streamToFile(vUrl, tmpV, task);
          ensureActive(task); // 视频流下完若已取消，不再继续下音频
          await streamToFile(aUrl, tmpA, task);
          ensureActive(task);

          task.status = 'merging';
          await mergeStreams(tmpV, tmpA, filePath, task);
        } finally {
          // 成功、失败、取消都清掉临时分片（成功时成品已在 filePath）
          await fsp.unlink(tmpV).catch(() => {});
          await fsp.unlink(tmpA).catch(() => {});
        }
      } else {
        /* ---------- 常规：DURL 单文件（音视频已合并） ---------- */
        const d = await biliApi(endpoint, {
          ...baseParams,
          qn: wantQn,
          fnval: 1,
          fourk: 1,
        });

        const urls = (d.durl || []).map((x) => x.url).filter(Boolean);
        if (!urls.length) throw new Error('未获取到可下载地址，可能是付费或充电专属内容');

        // 用服务端真实给到的清晰度命名，避免「标着 1080P 实际 720P」
        const realQn = d.quality || wantQn;
        const qLabel = QN_LABEL[realQn] || `${realQn}`;

        const filePath = await uniquePath(
          downloadDir(),
          `${baseTitle}${partSuffix} [${qLabel}].mp4`
        );

        task.filename = path.basename(filePath);
        task.filePath = filePath;
        task.quality = qLabel;
        ensureActive(task);
        task.status = 'downloading';

        if (urls.length === 1) {
          await withRetry(
            () => {
              // 重试要从零开始统计，否则进度会跳
              task.downloaded = 0;
              task.total = 0;
              return streamToFile(urls[0], filePath, task);
            },
            { times: 2, shouldStop: () => task.status === 'canceled' }
          );
        } else {
          // 极少数老视频是多段分片，按顺序写入同一文件
          const fd = fs.openSync(filePath + '.part', 'w');
          for (const u of urls) {
            if (task.status === 'canceled') throw new Error('已取消');
            await appendSegment(u, fd, task);
          }
          fs.closeSync(fd);
          fs.renameSync(filePath + '.part', filePath);
        }
      }

      ensureActive(task);
      task.status = 'done';
      task.total = task.total || task.downloaded;
    } catch (e) {
      if (task.status !== 'canceled') {
        task.status = 'error';
        task.error = e.message;
      }
    } finally {
      task.finishedAt = Date.now();
      task.speed = 0;
      task._res = null;
      task._ffmpeg = null;
      // 任务结束即释放文件名预留（文件若已落盘，uniquePath 会靠磁盘检查避开同名）
      if (task.filePath) reservedPaths.delete(task.filePath);
    }
  });

  return task;
}

/**
 * 下载纯音频。
 * B 站的 DASH 音频轨是标准 fMP4（ftyp + moov 在前），落地为 .m4a 后主流播放器可直接播放，
 * 因此不需要 ffmpeg 转码。
 */
async function startAudioDownload(opts) {
  const { bvid, aid, epId, cid, audioId, title, part, index, pageCount } = opts || {};
  if (!cid) throw new Error('缺少分 P 信息，请先解析视频');

  await ensureDownloadDir();

  const task = newTask({
    type: 'audio',
    title: title || 'bilibili 音频',
    filename: '',
    filePath: '',
    quality: AUDIO_LABEL[audioId] || '音频',
    status: 'queued',
  });
  task.retry = { kind: 'audio', payload: { ...(opts || {}) } };

  enqueueDownload(task, async () => {
    try {
      task.status = 'resolving';

      const params = { cid, fnval: 4048, fourk: 1 };
      if (epId) params.ep_id = epId;
      else if (bvid) params.bvid = bvid;
      else params.avid = aid;

      const endpoint = epId ? '/pgc/player/web/playurl' : '/x/player/playurl';
      const d = await biliApi(endpoint, params);

      const dash = d.dash || {};
      const list = [...(dash.audio || [])];
      if (dash.dolby && dash.dolby.audio) list.push(dash.dolby.audio);
      if (dash.flac && dash.flac.audio) list.push(dash.flac.audio);

      if (!list.length) throw new Error('未获取到音频流，该视频可能是纯音乐或受版权限制');

      const pick =
        list.find((a) => String(a.id) === String(audioId)) ||
        list.sort((a, b) => b.bandwidth - a.bandwidth)[0];

      const url = pick.baseUrl || (pick.base_url) || '';
      if (!url) throw new Error('音频地址为空，请稍后重试');

      const label = AUDIO_LABEL[pick.id] || `${Math.round(pick.bandwidth / 1000)}K`;

      const baseTitle = safeName(title || 'bilibili 音频');
      const partSuffix =
        pageCount > 1 ? ` - P${index || 1} ${safeName(part || '')}`.trimEnd() : '';
      const filePath = await uniquePath(downloadDir(), `${baseTitle}${partSuffix} [${label}].m4a`);

      task.filename = path.basename(filePath);
      task.filePath = filePath;
      task.quality = label;
      task.status = 'downloading';

      await withRetry(
        () => {
          task.downloaded = 0;
          task.total = 0;
          return streamToFile(url, filePath, task);
        },
        { times: 2, shouldStop: () => task.status === 'canceled' }
      );

      ensureActive(task);
      task.status = 'done';
      task.total = task.total || task.downloaded;
    } catch (e) {
      if (task.status !== 'canceled') {
        task.status = 'error';
        task.error = e.message;
      }
    } finally {
      task.finishedAt = Date.now();
      task.speed = 0;
      task._res = null;
      task._ffmpeg = null;
      if (task.filePath) reservedPaths.delete(task.filePath);
    }
  });

  return task;
}

/** 多段拼接用：把一段流追加写入已打开的文件 */
function appendSegment(urlStr, fd, task) {
  return new Promise((resolve, reject) => {
    requestGet(urlStr, {
      Referer: 'https://www.bilibili.com/',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    })
      .then(async (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`分片下载失败 HTTP ${res.statusCode}`));
        }
        for await (const chunk of res) {
          fs.writeSync(fd, chunk);
          task.downloaded += chunk.length;
        }
        resolve();
      })
      .catch(reject);
  });
}

async function startCoverDownload(opts) {
  const { url, title } = opts || {};
  if (!url) throw new Error('缺少封面地址');
  await ensureDownloadDir();

  const clean = hdCover(url);
  const ext = (clean.match(/\.(jpg|jpeg|png|webp|gif)$/i) || [, 'jpg'])[1].toLowerCase();
  const filename = `${safeName(title || 'cover')} - 封面.${ext === 'jpeg' ? 'jpg' : ext}`;
  const filePath = await uniquePath(downloadDir(), filename);

  const task = newTask({
    type: 'cover',
    title: title || '封面',
    filename: path.basename(filePath),
    filePath,
    quality: '原图',
  });
  task.retry = { kind: 'cover', payload: { ...(opts || {}) } };
  task.status = 'downloading';

  (async () => {
    try {
      await streamToFile(clean, filePath, task);
      ensureActive(task);
      task.status = 'done';
      task.finishedAt = Date.now();
      task.total = task.total || task.downloaded;
    } catch (e) {
      if (task.status !== 'canceled') {
        task.status = 'error';
        task.error = e.message;
      }
      task.finishedAt = Date.now();
    } finally {
      task._res = null;
      reservedPaths.delete(filePath);
    }
  })();

  return task;
}

/* ============================================================
 * 在线演示下载：服务端取流，浏览器直接收，不写服务器磁盘
 * ------------------------------------------------------------
 * 与本机 /api/download 完全分开：这里不接受凭证、不碰目录，
 * 只接受解析过的 bvid/cid/清晰度，再校验 CDN 域名后转发字节流。
 * ============================================================ */

const DEMO_STREAM_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
};

function demoError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function contentDisposition(filename) {
  const name = String(filename || 'download');
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 把一段或多段 DURL 顺序写入响应；不缓冲整文件，不落盘 */
function streamDemoUrls(res, urls) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let current = null;
    let done = false;
    let i = 0;

    const finish = (err) => {
      if (done) return;
      done = true;
      if (current && typeof current.destroy === 'function') current.destroy();
      if (err) {
        if (!res.destroyed) res.destroy(err);
        reject(err);
      } else {
        if (!res.writableEnded) res.end();
        resolve();
      }
    };

    res.on('close', () => finish(new Error('客户端已断开')));

    const next = () => {
      if (done) return;
      if (i >= urls.length) return finish();

      const url = urls[i++];
      requestGet(url, DEMO_STREAM_HEADERS, 0, demoStreamGuard)
        .then((r) => {
          if (done) {
            r.resume();
            return;
          }
          if (r.statusCode >= 400) {
            r.resume();
            return finish(demoError(502, `源文件返回 HTTP ${r.statusCode}`));
          }
          current = r;
          r.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > DEMO_MAX_BYTES) finish(demoError(413, '文件超过在线版大小上限'));
          });
          r.on('error', finish);
          r.on('end', () => {
            current = null;
            next();
          });
          r.pipe(res, { end: false });
        })
        .catch(finish);
    };

    next();
  });
}

/** 根据查询参数准备下载地址与响应头；出错时还没写响应，可以安全返回 JSON */
async function prepareDemoDownload(q) {
  const type = ['video', 'audio', 'cover'].includes(q.get('type')) ? q.get('type') : 'video';
  const title = safeName(q.get('title') || (type === 'cover' ? 'cover' : 'bilibili 视频'));
  const part = safeName(q.get('part') || '');
  const index = Math.min(999, Math.max(1, Number(q.get('index')) || 1));
  const pageCount = Math.min(999, Math.max(1, Number(q.get('pageCount')) || 1));
  const suffix = pageCount > 1 ? ` - P${index}${part ? ' ' + part : ''}` : '';

  let rawUrls = [];
  let filename = '';
  let contentType = 'application/octet-stream';

  if (type === 'cover') {
    const raw = q.get('url') || '';
    const clean = hdCover(raw);
    if (!clean) throw demoError(400, '缺少封面地址');
    let u;
    try {
      u = new URL(clean);
    } catch {
      throw demoError(400, '封面地址不合法');
    }
    if (!demoStreamGuard(u)) throw demoError(403, '不允许的封面域名');

    rawUrls = [u.toString()];
    const ext = (u.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i) || [, 'jpg'])[1].toLowerCase();
    filename = `${title}${suffix} - 封面.${ext === 'jpeg' ? 'jpg' : ext}`;
    contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  } else {
    const cid = String(q.get('cid') || '').trim();
    const bvid = String(q.get('bvid') || '').trim();
    const aid = String(q.get('aid') || '').trim();
    const epId = String(q.get('epId') || '').trim();
    if (!cid) throw demoError(400, '缺少分 P 信息，请先解析视频');
    if (!bvid && !aid && !epId) throw demoError(400, '缺少视频标识，请重新解析');

    const baseParams = { cid };
    if (epId) baseParams.ep_id = epId;
    else if (bvid) baseParams.bvid = bvid;
    else baseParams.avid = aid;
    const endpoint = epId ? '/pgc/player/web/playurl' : '/x/player/playurl';

    if (type === 'video') {
      let qn = Number(q.get('qn')) || 64;
      if (qn > 74) throw demoError(403, '在线版最高支持 720P，高画质请在本机运行');

      const d = await biliApi(endpoint, { ...baseParams, qn, fnval: 1, fourk: 1 });
      rawUrls = (d.durl || []).map((x) => x.url).filter(Boolean);
      if (!rawUrls.length) throw demoError(404, '未获取到可下载地址，可能是付费或充电专属内容');

      const label = QN_LABEL[d.quality || qn] || `${d.quality || qn}`;
      filename = `${title}${suffix} [${safeName(label)}].mp4`;
      contentType = 'video/mp4';
    } else {
      const audioId = Number(q.get('audioId')) || 30280;
      const d = await biliApi(endpoint, { ...baseParams, fnval: 4048, fourk: 1 });
      const dash = d.dash || {};
      const tracks = [...(dash.audio || [])];
      if (dash.dolby && dash.dolby.audio) tracks.push(dash.dolby.audio);
      if (dash.flac && dash.flac.audio) tracks.push(dash.flac.audio);
      if (!tracks.length) throw demoError(404, '未找到可用音频轨');

      const a =
        tracks.find((x) => Number(x.id) === audioId) ||
        tracks.sort((x, y) => (y.bandwidth || 0) - (x.bandwidth || 0))[0];
      const url = a.baseUrl || a.base_url;
      if (!url) throw demoError(404, '音频地址为空，请稍后重试');

      rawUrls = [url];
      filename = `${title}${suffix} [${safeName(AUDIO_LABEL[a.id] || '音频')}].m4a`;
      contentType = 'audio/mp4';
    }
  }

  const urls = rawUrls.map(checkDemoStreamUrl);
  if (!urls.length || urls.some((u) => !u)) throw demoError(403, '下载地址不在允许范围内');

  let total = 0;
  for (const u of urls) {
    total += (await headSize(u, demoStreamGuard)) || 0;
  }
  if (total > DEMO_MAX_BYTES) {
    throw demoError(413, '文件超过在线版大小上限，请在本机下载');
  }

  return { urls, filename, contentType, total };
}

async function handleDemoDownload(req, res, q) {
  if (!DEMO) return sendJSON(res, 404, { ok: false, error: '未找到接口' });

  const ip = clientIp(req);
  if (demoDownloadLimited(ip)) {
    return sendJSON(res, 429, { ok: false, error: '在线下载过于频繁，请稍后再试' });
  }
  if (demoDownloadActive >= DEMO_MAX_ACTIVE) {
    return sendJSON(res, 429, { ok: false, error: '在线下载繁忙，请稍后再试' });
  }

  demoDownloadActive++;
  let started = false;
  try {
    const prepared = await prepareDemoDownload(q);
    const headers = {
      'Content-Type': prepared.contentType,
      'Content-Disposition': contentDisposition(prepared.filename),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none',
    };
    if (prepared.total) headers['Content-Length'] = prepared.total;

    res.writeHead(200, headers);
    started = true;
    await streamDemoUrls(res, prepared.urls);
  } catch (e) {
    if (!started) {
      sendJSON(res, e.status || 502, { ok: false, error: e.message || '在线下载失败' });
    } else if (!res.destroyed) {
      res.destroy(e);
    }
  } finally {
    demoDownloadActive--;
  }
}

/* ============================================================
 * HTTP 服务
 * ============================================================ */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = '/index.html';
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  const filePath = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));

  // 防目录穿越：解析后必须仍在 public 目录之内
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) throw new Error('is dir');

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    };

    // 页面单独下发 CSP：只允许加载本站脚本、本站样式与 B 站图床
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // 演示模式：所有会碰磁盘或存凭证的接口一律拒绝
  if (DEMO && demoBlocked(p)) {
    return sendJSON(res, 403, {
      ok: false,
      error: '在线版不支持此下载方式，请使用页面上的下载按钮',
    });
  }

  // 配置只读：不允许改保存位置、不允许写入任何凭证
  if (DEMO && p === '/api/config' && (req.method || 'GET').toUpperCase() !== 'GET') {
    return sendJSON(res, 403, {
      ok: false,
      error: '在线演示版不支持修改设置',
    });
  }

  // 在线下载：浏览器直收，不写服务器磁盘；只放行演示模式
  if (p === DEMO_DOWNLOAD_PATH && req.method === 'GET') {
    return handleDemoDownload(req, res, q);
  }

  try {
    /* ---------- 登录：申请二维码 ---------- */
    if (p === '/api/login/qr' && req.method === 'POST') {
      const data = await createLoginQr();
      return sendJSON(res, 200, { ok: true, data });
    }

    /* ---------- 登录：轮询扫码状态 ---------- */
    if (p === '/api/login/poll') {
      const key = q.get('key') || '';
      if (!key) return sendJSON(res, 400, { ok: false, error: '缺少 qrcode_key' });
      const data = await pollLogin(key);
      return sendJSON(res, 200, { ok: true, data });
    }

    /* ---------- 退出登录 ---------- */
    if (p === '/api/logout' && req.method === 'POST') {
      await logout();
      return sendJSON(res, 200, { ok: true, data: { user: null } });
    }

    /* ---------- 当前登录状态 ---------- */
    if (p === '/api/user') {
      const user = await fetchLoginUser();
      if (user) {
        config.user = user;
        await saveConfig();
      }
      return sendJSON(res, 200, { ok: true, data: { user } });
    }

    /* ---------- 解析视频 ---------- */
    if (p === '/api/parse') {
      const input = q.get('url') || '';
      const info = await resolveVideo(input);
      return sendJSON(res, 200, { ok: true, data: info });
    }

    /* ---------- 批量解析 ---------- */
    if (p === '/api/batch-parse' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.urls) ? body.urls : [];
      const cleaned = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];

      if (!cleaned.length) return sendJSON(res, 400, { ok: false, error: '没有有效的链接' });
      if (cleaned.length > 30) {
        return sendJSON(res, 400, { ok: false, error: '一次最多解析 30 条链接' });
      }

      const out = [];
      for (const input of cleaned) {
        try {
          const info = await resolveVideo(input);
          out.push({ ok: true, input, data: info });
        } catch (e) {
          out.push({ ok: false, input, error: e.message });
        }
        // 串行 + 轻微间隔，避免一次性打满接口触发风控
        await new Promise((r) => setTimeout(r, 120));
      }
      return sendJSON(res, 200, { ok: true, data: out });
    }

    /* ---------- 清晰度列表 ---------- */
    if (p === '/api/qualities') {
      const list = await probeQualities({
        bvid: q.get('bvid') || '',
        aid: q.get('aid') || '',
        cid: q.get('cid') || '',
        epId: q.get('epId') || '',
      });
      return sendJSON(res, 200, { ok: true, data: list });
    }

    /* ---------- 音频轨列表 ---------- */
    if (p === '/api/audio-qualities') {
      const list = await probeAudio({
        bvid: q.get('bvid') || '',
        aid: q.get('aid') || '',
        cid: q.get('cid') || '',
        epId: q.get('epId') || '',
      });
      return sendJSON(res, 200, { ok: true, data: list });
    }

    /* ---------- 开始下载视频 ---------- */
    if (p === '/api/download' && req.method === 'POST') {
      const body = await readBody(req);
      const task = await startVideoDownload(body);
      return sendJSON(res, 200, { ok: true, data: publicTask(task) });
    }

    /* ---------- 下载音频 ---------- */
    if (p === '/api/download-audio' && req.method === 'POST') {
      const body = await readBody(req);
      const task = await startAudioDownload(body);
      return sendJSON(res, 200, { ok: true, data: publicTask(task) });
    }

    /* ---------- 下载封面 ---------- */
    if (p === '/api/download-cover' && req.method === 'POST') {
      const body = await readBody(req);
      const task = await startCoverDownload(body);
      return sendJSON(res, 200, { ok: true, data: publicTask(task) });
    }

    /* ---------- 任务列表 ---------- */
    if (p === '/api/tasks') {
      const list = [...tasks.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 40)
        .map(publicTask);
      return sendJSON(res, 200, { ok: true, data: list });
    }

    /* ---------- 取消任务 ---------- */
    if (p === '/api/cancel') {
      const t = tasks.get(q.get('id'));
      const canceled = cancelTask(t);
      return sendJSON(res, 200, { ok: true, data: { canceled } });
    }

    /* ---------- 取消全部进行中的任务 ---------- */
    if (p === '/api/cancel-all') {
      let canceled = 0;
      for (const t of tasks.values()) {
        if (cancelTask(t)) canceled++;
      }
      return sendJSON(res, 200, { ok: true, data: { canceled } });
    }

    /* ---------- 重试失败/已取消的任务（复用原始参数，新建一条任务） ---------- */
    if (p === '/api/retry') {
      const t = tasks.get(q.get('id'));
      if (!t || !t.retry) {
        return sendJSON(res, 400, { ok: false, error: '该任务不可重试' });
      }
      const { kind, payload } = t.retry;
      let nt;
      if (kind === 'video') nt = await startVideoDownload(payload);
      else if (kind === 'audio') nt = await startAudioDownload(payload);
      else nt = await startCoverDownload(payload);
      return sendJSON(res, 200, { ok: true, data: publicTask(nt) });
    }

    /* ---------- 封面代理（用于页面内预览，绕过防盗链） ---------- */
    if (p === '/api/cover') {
      const target = q.get('url');
      if (!target) return sendJSON(res, 400, { ok: false, error: '缺少 url' });

      // 只代理 B 站自己的图片域名，避免被当成任意地址的跳板
      const clean = hdCover(target);
      let targetUrl = null;
      try {
        targetUrl = new URL(clean);
      } catch {
        return sendJSON(res, 400, { ok: false, error: '封面地址不合法' });
      }
      if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
        return sendJSON(res, 400, { ok: false, error: '封面地址不合法' });
      }
      if (!isBiliImageHost(targetUrl.hostname)) {
        return sendJSON(res, 403, { ok: false, error: '不允许的封面域名' });
      }

      const r = await requestGet(
        clean,
        { Referer: 'https://www.bilibili.com/' },
        0,
        (u) => isBiliImageHost(u.hostname)
      );
      if (r.statusCode >= 400) {
        r.resume();
        return sendJSON(res, 502, { ok: false, error: '封面拉取失败' });
      }

      // 只接受图片类型：万一上游返回 HTML，也不会被当页面渲染
      const ctype = String(r.headers['content-type'] || 'image/jpeg');
      if (!/^image\//i.test(ctype)) {
        r.resume();
        return sendJSON(res, 502, { ok: false, error: '封面不是图片' });
      }

      res.writeHead(200, {
        'Content-Type': ctype,
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=3600',
      });
      r.pipe(res);
      return;
    }

    /* ---------- 配置读写 ---------- */
    if (p === '/api/config') {
      if (req.method === 'GET') {
        return sendJSON(res, 200, {
          ok: true,
          data: {
            downloadDir: downloadDir(),
            hasCookie: Boolean(config.cookie),
            defaultDownloadDir: DEFAULT_DOWNLOAD_DIR,
            user: config.cookie ? config.user : null,
            queue: queueStatus(),
            hasFfmpeg: Boolean(FFMPEG_PATH),
            demo: DEMO,
          },
        });
      }
      const body = await readBody(req);
      if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
        const raw = body.downloadDir.trim();
        if (raw.includes('\0')) {
          return sendJSON(res, 400, { ok: false, error: '路径不合法' });
        }
        if (!path.isAbsolute(raw)) {
          return sendJSON(res, 400, { ok: false, error: '请填写绝对路径，例如 D:\\Downloads' });
        }
        const abs = path.resolve(raw);
        // 已存在但不是目录 → 拒绝，免得后面 mkdir 报错
        try {
          const st = await fsp.stat(abs);
          if (!st.isDirectory()) {
            return sendJSON(res, 400, { ok: false, error: '这个路径不是文件夹' });
          }
        } catch {
          /* 不存在没关系，下载前会创建 */
        }
        config.downloadDir = abs;
      }
      if (typeof body.cookie === 'string') {
        // 允许只填 SESSDATA 值，自动补全键名
        let ck = body.cookie.trim();
        if (ck.length > 8192) {
          return sendJSON(res, 400, { ok: false, error: '凭证长度异常' });
        }
        if (ck && !ck.includes('=')) ck = 'SESSDATA=' + ck;
        config.cookie = ck;
        if (!ck) config.user = null;
      }
      await saveConfig();
      if (config.cookie) {
        await initGuestCookie();
        const u = await fetchLoginUser();
        if (u) {
          config.user = u;
          await saveConfig();
        } else {
          config.cookie = '';
          config.user = null;
          await saveConfig();
          return sendJSON(res, 200, {
            ok: true,
            data: { downloadDir: downloadDir(), hasCookie: false, user: null, error: 'Cookie 无效，已清除' },
          });
        }
      }
      return sendJSON(res, 200, {
        ok: true,
        data: { downloadDir: downloadDir(), hasCookie: Boolean(config.cookie), user: config.user },
      });
    }

    /* ---------- 目录浏览（用于「选择保存位置」） ---------- */
    if (p === '/api/fs/roots') {
      const roots = [];

      if (process.platform === 'win32') {
        for (let i = 67; i <= 90; i++) {
          const drive = `${String.fromCharCode(i)}:\\`;
          try {
            if (fs.existsSync(drive)) roots.push({ name: drive.slice(0, 2), path: drive });
          } catch {
            /* 跳过不可访问的盘符 */
          }
        }
      } else {
        roots.push({ name: '/', path: '/' });
      }

      const home = os.homedir();
      const shortcuts = [
        { name: '桌面', path: path.join(home, 'Desktop') },
        { name: '下载', path: path.join(home, 'Downloads') },
        { name: '文档', path: path.join(home, 'Documents') },
        { name: '用户目录', path: home },
      ].filter((s) => {
        try {
          return fs.statSync(s.path).isDirectory();
        } catch {
          return false;
        }
      });

      return sendJSON(res, 200, { ok: true, data: { roots, shortcuts, home } });
    }

    if (p === '/api/fs/list') {
      const target = q.get('path') || os.homedir();
      const abs = path.resolve(target);

      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        return sendJSON(res, 400, { ok: false, error: '目录不存在或无法访问' });
      }

      const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
        // 跳过系统隐藏目录，省得列表里全是噪音
        .filter(
          (d) =>
            !d.name.startsWith('.') &&
            !d.name.startsWith('$') &&
            d.name !== 'System Volume Information'
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, 300);

      const parent = path.dirname(abs);
      return sendJSON(res, 200, {
        ok: true,
        data: { path: abs, parent: parent === abs ? '' : parent, dirs },
      });
    }

    /* ---------- 打开下载目录 ---------- */
    if (p === '/api/open-folder') {
      await ensureDownloadDir();
      const dir = path.resolve(downloadDir());
      try {
        await openLocalTarget(dir);
      } catch (e) {
        return sendJSON(res, 500, {
          ok: false,
          error: '无法打开文件夹：' + (e.message || e.code || '未知错误'),
        });
      }
      return sendJSON(res, 200, { ok: true, data: { dir } });
    }

    /* ---------- 安全状态 ---------- */
    if (p === '/api/security') {
      return sendJSON(res, 200, {
        ok: true,
        data: {
          // 按真实监听地址报告：本机版只听 127.0.0.1，演示版需要监听 0.0.0.0 供容器转发
          localOnly: !DEMO,
          listenHost: DEMO ? '0.0.0.0' : '127.0.0.1',
          hostGuard: !DEMO, // 演示版域名由平台分配，Host 无法预枚举
          originGuard: true, // 跨站写操作被拒
          csp: true, // 严格内容安全策略
          rateLimit: RATE_LIMIT,
          rateWindow: Math.round(RATE_WINDOW / 1000),
          hasCredential: Boolean(config.cookie),
          credentialEncrypted: SECURITY_STATE.credentialEncrypted,
          configPerm: SECURITY_STATE.configPerm,
        },
      });
    }

    /* ---------- 健康检查 ---------- */
    if (p === '/api/ping') {
      return sendJSON(res, 200, {
        ok: true,
        data: {
          hasCookie: Boolean(config.cookie),
          user: config.cookie ? config.user : null,
          queue: queueStatus(),
          hasFfmpeg: Boolean(FFMPEG_PATH),
          demo: DEMO,
        },
      });
    }

    return sendJSON(res, 404, { ok: false, error: '未知接口' });
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message || String(e) });
  }
}

function publicTask(t) {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    filename: t.filename,
    status: t.status,
    downloaded: t.downloaded,
    total: t.total,
    speed: t.speed,
    error: t.error,
    quality: t.quality,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    canCancel: !TASK_TERMINAL.has(t.status),
  };
}

/* ============================================================
 * 启动
 * ============================================================ */

/**
 * 打开本机目录或链接。
 * ------------------------------------------------------------
 * Windows 下不能用 windowsHide：它会把 explorer 的窗口一起藏掉，
 * 表现就是接口返回成功、用户却「什么都没发生」。
 * 另外 explorer.exe 正常唤起后经常以退出码 1 结束，所以只看 spawn 错误，
 * 不看 exit code —— 否则会误报失败。
 */
function openLocalTarget(target) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      if (process.platform === 'win32') {
        const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
        child = spawn(explorer, [target], { detached: true, stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        child = spawn('open', [target], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
      }
    } catch (e) {
      return reject(e);
    }

    let settled = false;
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function openBrowser(target) {
  // 打不开浏览器不该影响服务启动，静默降级即可
  openLocalTarget(target).catch(() => {});
}

function main() {
  loadConfig();
  initFFmpeg();

  // 演示模式下即使存在 config.json 也不使用：绝不让凭证留在公网服务里
  if (DEMO) {
    config.cookie = '';
    config.user = null;
    console.log('  演示模式：已忽略本地凭证，仅提供解析与在线下载');
  }

  // 每次启动都把配置文件权限再收紧一次：
  // 用户可能从别处拷回一个权限宽松的 config.json
  if (fs.existsSync(CONFIG_PATH)) tightenConfigPermissions();

  // 旧版本把 cookie 明文写在 config.json 里，这里开机就转成密文
  if (needsSecretMigration) {
    saveConfig()
      .then(() => console.log('  已把登录凭证加密保存。'))
      .catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    // 统一安全响应头
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 Bad Request');
    }

    // 只接受「本机地址 + 本页面」发起的请求
    const deny = rejectReason(req);
    if (deny) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 Forbidden');
    }

    if (url.pathname.startsWith('/api/')) {
      // 限流：脚本跑飞或死循环时，别把 B 站接口打爆
      if (rateLimited(req.socket.remoteAddress || 'local')) {
        return sendJSON(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      return handleApi(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method Not Allowed');
    }
    return serveStatic(req, res, url.pathname);
  });

  const startPort = Number(process.env.PORT || (DEMO ? 7860 : 7788));
  let attempts = 0;

  const tryListen = (port) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts < 12) {
        attempts++;
        setTimeout(() => tryListen(port + 1), 120);
      } else {
        console.error('启动失败：', err.message);
        process.exit(1);
      }
    });

    // 演示模式要监听 0.0.0.0，平台容器才能把流量转发进来
    server.listen(port, DEMO ? '0.0.0.0' : '127.0.0.1', async () => {
      await ensureDownloadDir();
      await initGuestCookie();

      const url = `http://127.0.0.1:${port}`;
      // 桌面壳靠这一行拿到真实端口（7788 被占用时服务会自动顺延）
      if (process.env.BILI_APP_IPC === '1') console.log('LISTENING=' + url);
      console.log('');
      console.log('  ┌─────────────────────────────────────────┐');
      console.log('  │   哔哩提取器 · B站视频/封面提取工具     │');
      console.log('  └─────────────────────────────────────────┘');
      console.log('');
      console.log(`  服务地址：${url}`);
      console.log(`  下载目录：${downloadDir()}`);
      console.log(`  登录状态：${config.cookie ? '已填写 Cookie' : '访客模式（最高 720P）'}`);
      console.log('');
      console.log('  关闭此窗口即可退出程序。');
      console.log('');

      if (!process.env.NO_OPEN) openBrowser(url);
    });
  };

  tryListen(startPort);
}

main();
