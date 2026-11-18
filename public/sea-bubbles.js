/* ============================================================
   背景水泡动画
   思路参考 canvas-nest / particles.js：canvas 铺底、低密度、只动 opacity 与位置。
   这里换成更克制的水泡上浮：数量少、透明度低、不连线，避免干扰正文阅读。
   ============================================================ */

(function () {
  const canvas = document.getElementById('seaCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const PREF_KEY = 'bili-pref';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0;
  let H = 0;
  let dpr = 1;
  let bubbles = [];
  let rafId = null;
  let running = false;
  let theme = document.documentElement.getAttribute('data-theme') || 'light';

  /* ---------- 偏好 ---------- */

  function isEnabled() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      return p.sea !== false; // 默认开启
    } catch {
      return true;
    }
  }

  /* ---------- 画布尺寸 ---------- */

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- 粒子 ---------- */

  /** 按面积决定数量，但设上限，大屏也不会糊成一片 */
  function targetCount() {
    const byArea = Math.round((W * H) / 30000);
    return Math.max(14, Math.min(40, byArea));
  }

  function makeBubble(fromBottom) {
    // 幂次分布：小泡多、大泡少，比均匀随机自然得多
    const r = 3 + Math.pow(Math.random(), 1.6) * 10; // 3 ~ 13px，大小差异更明显
    const t = (13 - r) / 10; // 1 = 最小, 0 = 最大

    return {
      x: Math.random() * W,
      y: fromBottom ? H + r * 2 : Math.random() * H,
      r,
      // 大气泡浮得更慢（物理上也是）
      vy: -(0.05 + t * 0.11 + Math.random() * 0.03),
      // 每个泡一套独立的运动参数，避免所有气泡走同一条曲线
      vx: (Math.random() - 0.5) * 0.18,
      swayAmp: 0.15 + Math.random() * 0.85,
      swayFreq: 0.004 + Math.random() * 0.016,
      seed: Math.random() * Math.PI * 2,
      phase: Math.random() * Math.PI * 2,
      // 大泡更淡，像沉在更深的水里
      alpha: 0.17 + t * 0.15 + Math.random() * 0.05,
    };
  }

  function seed() {
    const n = targetCount();
    bubbles = Array.from({ length: n }, () => makeBubble(false));
  }

  /* ---------- 绘制 ---------- */

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // 亮色主题用海蓝，暗色用亮青，保证在不同底色上都「若隐若现」
    const rgb = theme === 'dark' ? '120, 205, 245' : '25, 118, 210';

    for (const b of bubbles) {
      // 上升速度做细微起伏，像被水流托着
      const breathe = 0.88 + Math.sin(b.phase * 0.6 + b.seed) * 0.12;
      b.y += b.vy * breathe;

      // 两条不同频率的摆动叠加 + 自身横向漂移，轨迹就不重样了
      b.x +=
        Math.sin(b.phase) * b.swayAmp +
        Math.sin(b.phase * 0.43 + b.seed) * b.swayAmp * 0.45 +
        b.vx;
      b.phase += b.swayFreq;

      // 从左右飘出画面时折回，避免越飘越远
      if (b.x < -b.r * 4) b.x = W + b.r * 4;
      else if (b.x > W + b.r * 4) b.x = -b.r * 4;

      // 飘出顶部后从底部重来，保持数量恒定
      if (b.y < -b.r * 4) {
        Object.assign(b, makeBubble(true));
      }

      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb}, ${b.alpha * 0.55})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb}, ${b.alpha})`;
      ctx.lineWidth = Math.min(1.5, 0.6 + b.r * 0.09);
      ctx.stroke();

      // 左上一颗高光，让它看起来像个泡而不是实心点
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.32, b.r * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${b.alpha * 0.85})`;
      ctx.fill();
    }
  }

  function loop() {
    if (!running) return;
    draw();
    rafId = requestAnimationFrame(loop);
  }

  /* ---------- 启停 ---------- */

  function start() {
    if (running || reduceMotion || !isEnabled()) return;
    resize();
    seed();
    running = true;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    ctx.clearRect(0, 0, W, H);
  }

  function restart() {
    stop();
    start();
  }

  /* ---------- 事件 ---------- */

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!running) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      seed();
    }, 180);
  });

  // 主题切换时换配色，不用重启
  new MutationObserver(() => {
    theme = document.documentElement.getAttribute('data-theme') || 'light';
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  // 页面在后台时停掉，回来再继续，省电
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    } else if (running) {
      rafId = requestAnimationFrame(loop);
    }
  });

  /* ---------- 对外接口 ---------- */

  window.SeaBubbles = {
    setEnabled(on) {
      if (on) start();
      else stop();
    },
    refresh: restart,
  };

  // 等首屏渲染完再启动，避免和入场动画抢主线程
  window.addEventListener('load', () => {
    setTimeout(start, 400);
  });
})();
