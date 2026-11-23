'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, getJSON } = require('./helpers/server');

let app;

test.before(async () => {
  app = await startServer();
});

test.after(async () => {
  if (app) await app.stop();
});

test('健康检查可用', async () => {
  const { status, body } = await getJSON(app.base + '/api/ping');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.demo, false);
  assert.deepEqual(body.data.queue, { active: 0, waiting: 0 });
});

test('安全状态如实报告本机监听', async () => {
  const { body } = await getJSON(app.base + '/api/security');
  assert.equal(body.data.localOnly, true);
  assert.equal(body.data.listenHost, '127.0.0.1');
  assert.equal(body.data.csp, true);
  assert.equal(body.data.originGuard, true);
});

test('响应头带严格 CSP，且禁止被嵌套', async () => {
  const res = await fetch(app.base + '/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('Host 不是本机地址时拒绝', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: app.port,
        path: '/api/ping',
        headers: { Host: 'evil.example.com' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('跨站 Origin 的写操作被拒', async () => {
  const { status, body } = await getJSON(app.base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ downloadDir: app.dataRoot }),
  });
  assert.equal(status, 403);
  if (body) assert.equal(body.ok, false);
});

test('同源写操作可正常保存设置', async () => {
  const { status, body } = await getJSON(app.base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ downloadDir: app.dataRoot }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('路径穿越读不到源码', async () => {
  for (const p of ['/../server.js', '/..%2Fserver.js', '/%2e%2e/server.js']) {
    const res = await fetch(app.base + p);
    const text = await res.text();
    assert.notEqual(res.status, 200, `路径 ${p} 不应返回 200`);
    assert.doesNotMatch(text, /require\('http'\)/, `路径 ${p} 不应泄露源码`);
  }
});

test('任务列表初始为空', async () => {
  const { body } = await getJSON(app.base + '/api/tasks');
  assert.deepEqual(body.data, []);
});

test('取消不存在的任务返回 canceled=false', async () => {
  const { body } = await getJSON(app.base + '/api/cancel?id=not-exist');
  assert.equal(body.ok, true);
  assert.equal(body.data.canceled, false);
});

test('重试不存在的任务返回 400', async () => {
  const { status, body } = await getJSON(app.base + '/api/retry?id=not-exist', { method: 'POST' });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test('取消全部在空闲时不报错', async () => {
  const { body } = await getJSON(app.base + '/api/cancel-all', { method: 'POST' });
  assert.equal(body.ok, true);
  assert.equal(body.data.canceled, 0);
});
