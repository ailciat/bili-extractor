#!/usr/bin/env node
'use strict';

/**
 * 打包成「解压即用」的便携版
 * ------------------------------------------------------------
 * 产物：dist/bili-extractor-v<版本>-<平台>.zip
 * 里面已经带上 node_modules，对方不需要装依赖、不需要懂 npm，
 * 解压后双击（Windows）或执行 ./start.sh（macOS/Linux）即可。
 *
 * 注意：压缩包里的 ffmpeg 是**当前平台**的二进制。
 * 在 Windows 上打出来的包，换到 macOS 就需要在 macOS 上重新打一次。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const tag = `${process.platform}-${process.arch}`;
const baseName = `bili-extractor-v${pkg.version}-${tag}`;
const distDir = path.join(ROOT, 'dist');
const stageDir = path.join(distDir, baseName);
const zipPath = path.join(distDir, baseName + '.zip');

// 打进包里的东西；config.json 与 downloads 的内容刻意排除
const INCLUDE = [
  'server.js',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  '启动.bat',
  'start.sh',
  'public',
  'electron',
  'scripts',
];

function step(msg) {
  console.log(`  ${msg}`);
}

function main() {
  console.log(`\n打包 ${baseName}\n`);

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('  ✗ 没有 node_modules，先执行 npm install 再打包');
    process.exit(1);
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(stageDir, item), { recursive: true });
  }
  step('✓ 源码与脚本');

  // 依赖整包带上，这是「解压即用」的关键
  fs.cpSync(path.join(ROOT, 'node_modules'), path.join(stageDir, 'node_modules'), {
    recursive: true,
  });
  step('✓ node_modules');

  // 空下载目录，避免用户第一次找不到文件存哪
  fs.mkdirSync(path.join(stageDir, 'downloads'), { recursive: true });
  fs.writeFileSync(
    path.join(stageDir, '下载到这里.txt'),
    '下载的视频、音频、封面默认保存在这个文件夹。\r\n可在程序右上角「设置」里改成别的位置。\r\n',
    'utf8'
  );

  fs.rmSync(zipPath, { force: true });

  if (process.platform === 'win32') {
    step('压缩中（Compress-Archive）…');
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
      ],
      { stdio: 'inherit' }
    );
    if (r.status !== 0) {
      console.error('  ✗ 压缩失败');
      process.exit(1);
    }
  } else {
    step('压缩中（zip）…');
    const r = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('  ✗ 压缩失败，确认系统里有 zip 命令');
      process.exit(1);
    }
  }

  const size = fs.statSync(zipPath).size / 1024 / 1024;
  step(`✓ ${path.relative(ROOT, zipPath)}（${size.toFixed(1)} MB）`);

  fs.rmSync(stageDir, { recursive: true, force: true });

  console.log('\n完成。把这个 zip 发给别人，解压后双击 启动.bat 即可，不用装依赖。\n');
}

main();
