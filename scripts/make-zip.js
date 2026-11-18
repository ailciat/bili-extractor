// 把 dist 里的中文名 exe 打成英文名的 zip，规避 GitHub 上传时对非 ASCII 资源名的处理。
// zip 内文件名用 UTF-8 标记写入，Windows 资源管理器 / 7z / unzip 均能正确显示中文。
// 采用 store 模式（exe 本身已压缩，再压缩收益极小且很慢）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const distDir = path.join(__dirname, '..', 'dist');
const version = require('../package.json').version;
const zipName = 'bili-extractor-' + version + '-win-x64.zip';

const exe = fs.readdirSync(distDir).find(f => f.toLowerCase().endsWith('.exe'));
if (!exe) throw new Error('dist 下没有 exe，请先运行 npm run app:pack');

const data = fs.readFileSync(path.join(distDir, exe));
const nameBuf = Buffer.from(exe, 'utf8');

// CRC32：优先用 Node 内置（20.15+），否则回退查表法
let table = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const crc = crc32(data);

const now = new Date();
const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

// Local file header
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);
local.writeUInt16LE(0x0800, 6); // bit 11: UTF-8 文件名
local.writeUInt16LE(0, 8);      // store
local.writeUInt16LE(dosTime, 10);
local.writeUInt16LE(dosDate, 12);
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(data.length, 18);
local.writeUInt32LE(data.length, 22);
local.writeUInt16LE(nameBuf.length, 26);
local.writeUInt16LE(0, 28);

// Central directory header
const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4);
central.writeUInt16LE(20, 6);
central.writeUInt16LE(0x0800, 8);
central.writeUInt16LE(0, 10);
central.writeUInt16LE(dosTime, 12);
central.writeUInt16LE(dosDate, 14);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(data.length, 20);
central.writeUInt32LE(data.length, 24);
central.writeUInt16LE(nameBuf.length, 28);
central.writeUInt16LE(0, 30);
central.writeUInt16LE(0, 32);
central.writeUInt16LE(0, 34);
central.writeUInt16LE(0, 36);
central.writeUInt32LE(0, 38);
central.writeUInt32LE(0, 42);

// End of central directory
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(1, 8);
eocd.writeUInt16LE(1, 10);
eocd.writeUInt32LE(central.length + nameBuf.length, 12);
eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16);
eocd.writeUInt16LE(0, 20);

const outPath = path.join(distDir, zipName);
fs.writeFileSync(outPath, Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]));
console.log('已生成 ' + zipName + '，内部文件：' + exe + '（' + data.length + ' 字节）');
