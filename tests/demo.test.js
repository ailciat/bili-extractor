'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, getJSON } = require('./helpers/server');

let demo;

test.before(async () => {
  demo = await startServer({ STUDIO_DEMO: '1' });
});

test.after(async () => {
  if (demo) await demo.stop();
});

test('演示模式如实报告监听 0.0.0.0', async () => {
  const { body } = await getJSON(demo.base + '/api/security');
  assert.equal(body.data.localOnly, false);
  assert.equal(body.data.listenHost, '0.0.0.0');
  assert.equal(body.data.hostGuard, false);
});

test('演示模式拒绝写设置', async () => {
  const { status, body } = await getJSON(demo.base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadDir: demo.dataRoot }),
  });
  assert.equal(status, 403);
  assert.equal(body.ok, false);
});

test('演示模式拒绝落盘下载', async () => {
  const { status, body } = await getJSON(demo.base + '/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvid: 'BV1GJ411x7h7', cid: 1, qn: 64 }),
  });
  assert.equal(status, 403);
  assert.equal(body.ok, false);
  assert.match(body.error, /在线版/);
});

test('演示模式仍可解析入口存在（不触网，仅校验参数错误）', async () => {
  const { status, body } = await getJSON(demo.base + '/api/parse');
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});
