#!/usr/bin/env node
'use strict';

/**
 * 依赖自检 / 自动安装
 * ------------------------------------------------------------
 * 目的：让别人 clone 下来双击就能用，不必先看懂 npm。
 *
 * 两个依赖各管一件事，缺了也能跑，只是功能降级：
 *   qrcode      → 扫码登录（缺了只能手动填 Cookie）
 *   ffmpeg      → 1080P 以上音视频合并（缺了最高 720P）
 *
 * 所以安装失败不阻断启动，只提示后果。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIRROR = 'https://registry.npmmirror.com';

function hasQrcode() {
  try {
    require.resolve('qrcode', { paths: [ROOT] });
    return true;
  } catch {
    return false;
  }
}

function hasFfmpeg() {
  try {
    const f = require('@ffmpeg-installer/ffmpeg');
    return Boolean(f && f.path && fs.existsSync(f.path));
  } catch {
    return false;
  }
}

function check() {
  return { qrcode: hasQrcode(), ffmpeg: hasFfmpeg() };
}

function npmInstall(extra = []) {
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund', ...extra];
  console.log(`  > npm ${args.join(' ')}`);

  const r = spawnSync('npm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    timeout: 5 * 60 * 1000,
  });

  return r.status === 0;
}

function main() {
  const before = check();

  if (before.qrcode && before.ffmpeg) {
    console.log('  依赖完整：二维码 + ffmpeg 都在。');
    return;
  }

  console.log('');
  console.log('  缺少依赖：');
  if (!before.qrcode) console.log('    · qrcode —— 扫码登录需要');
  if (!before.ffmpeg) console.log('    · ffmpeg —— 1080P 以上合并需要');
  console.log('');

  // 只检查不安装
  if (process.argv.includes('--check')) {
    console.log('  （--check 模式，不执行安装）');
    return;
  }

  console.log('  正在自动安装（约 64MB，只需要这一次）…');

  let ok = npmInstall();

  // 官方源在部分地区会超时，换国内镜像再试一次
  if (!ok) {
    console.log('');
    console.log('  官方源失败，改用国内镜像重试…');
    ok = npmInstall(['--registry=' + MIRROR]);
  }

  const after = check();
  console.log('');

  if (after.qrcode && after.ffmpeg) {
    console.log('  依赖安装完成。');
    return;
  }

  console.log('  [提示] 依赖没装全，程序仍可启动，但功能会受限：');
  if (!after.qrcode) console.log('    · 扫码登录不可用（可在设置里手动填 SESSDATA）');
  if (!after.ffmpeg) console.log('    · 最高只能下 720P');
  console.log('');
  console.log('  想手动安装时，在项目目录执行：');
  console.log('    npm install --registry=https://registry.npmmirror.com');
  console.log('');
}

main();
