'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, getJSON } = require('./helpers/server');

const SALT = 'bili-extractor::credential::v1';

function legacyKey() {
  let user = '';
  try {
    user = os.userInfo().username || '';
  } catch {
    user = process.env.USERNAME || process.env.USER || '';
  }
  return crypto.pbkdf2Sync(`${os.hostname()}|${user}|bili-extractor`, SALT, 120000, 32, 'sha256');
}

function encryptWith(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decryptWith(key, payload) {
  try {
    const buf = Buffer.from(String(payload), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function readConfig(dataRoot) {
  return JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('无 IPC 时退回派生密钥，仍能解出旧密文', async () => {
  const app = await startServer(
    {},
    {
      seed(dataRoot) {
        fs.writeFileSync(
          path.join(dataRoot, 'config.json'),
          JSON.stringify(
            {
              downloadDir: path.join(dataRoot, 'downloads'),
              cookieEnc: encryptWith(legacyKey(), 'SESSDATA=derived_test'),
              user: null,
            },
            null,
            2
          ),
          'utf8'
        );
      },
    }
  );

  try {
    const ping = await getJSON(app.base + '/api/ping');
    assert.equal(ping.body.data.hasCookie, true, '应能解出凭证');

    const sec = await getJSON(app.base + '/api/security');
    assert.equal(sec.body.data.credentialStore, 'derived');
    assert.equal(sec.body.data.credentialEncrypted, true);
  } finally {
    await app.stop();
  }
});

test('有系统密钥时用系统密钥加密，派生密钥解不开', async () => {
  const key = crypto.randomBytes(32);
  const keyB64 = key.toString('base64');

  const app = await startServer(
    {},
    {
      ipcKey: keyB64,
      seed(dataRoot) {
        fs.writeFileSync(
          path.join(dataRoot, 'config.json'),
          JSON.stringify(
            {
              downloadDir: path.join(dataRoot, 'downloads'),
              cookieEnc: encryptWith(key, 'SESSDATA=os_test'),
              user: null,
            },
            null,
            2
          ),
          'utf8'
        );
      },
    }
  );

  try {
    const ping = await getJSON(app.base + '/api/ping');
    assert.equal(ping.body.data.hasCookie, true, '系统密钥应能解出凭证');

    const saved = readConfig(app.dataRoot);
    assert.equal(decryptWith(key, saved.cookieEnc), 'SESSDATA=os_test');
    assert.equal(decryptWith(legacyKey(), saved.cookieEnc), '', '派生密钥不应能解开');

    const sec = await getJSON(app.base + '/api/security');
    assert.equal(sec.body.data.credentialStore, 'os');
  } finally {
    await app.stop();
  }
});

test('旧派生密钥密文自动迁移到系统密钥并留备份', async () => {
  const key = crypto.randomBytes(32);
  const keyB64 = key.toString('base64');
  const legacyEnc = encryptWith(legacyKey(), 'SESSDATA=legacy_value');

  const app = await startServer(
    {},
    {
      ipcKey: keyB64,
      seed(dataRoot) {
        fs.writeFileSync(
          path.join(dataRoot, 'config.json'),
          JSON.stringify({ downloadDir: path.join(dataRoot, 'downloads'), cookieEnc: legacyEnc, user: null }, null, 2),
          'utf8'
        );
      },
    }
  );

  try {
    let saved = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      saved = readConfig(app.dataRoot);
      if (decryptWith(key, saved.cookieEnc) === 'SESSDATA=legacy_value') break;
    }

    assert.equal(decryptWith(key, saved.cookieEnc), 'SESSDATA=legacy_value', '应已迁移到系统密钥');

    const bakPath = path.join(app.dataRoot, 'config.json.bak');
    assert.ok(fs.existsSync(bakPath), '应保留 config.json.bak');
    const bak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    assert.equal(decryptWith(legacyKey(), bak.cookieEnc), 'SESSDATA=legacy_value', '备份应仍是旧密文');
  } finally {
    await app.stop();
  }
});
