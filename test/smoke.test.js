'use strict';

// Tests de bon fonctionnement (le comportement "metier" nominal, pas la securite).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DB_FILE = path.join(os.tmpdir(), `wellwork-test-${Date.now()}.json`);
process.env.LOG_FILE = path.join(os.tmpdir(), `wellwork-test-${Date.now()}.log`);
process.env.LOG_STDOUT = '0';
const { createApp } = require('../src/app');

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const j = (r) => r.json();

test('health', async () => {
  await withServer(async (b) => assert.equal((await fetch(`${b}/api/health`)).status, 200));
});

test('inscription puis lecture du profil', async () => {
  await withServer(async (b) => {
    const r = await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.example', password: 'x', firstName: 'A' }) });
    assert.equal(r.status, 201);
    const { token } = await j(r);
    const me = await j(await fetch(`${b}/api/me`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(me.email, 'a@b.example');
  });
});

test('questionnaire enregistre', async () => {
  await withServer(async (b) => {
    const { token } = await j(await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'q@b.example', password: 'x' }) }));
    const r = await fetch(`${b}/api/questionnaires`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ answers: { stress: 5 } }) });
    assert.equal(r.status, 201);
  });
});

test('mot de passe non visible dans les logs', async () => {
  await withServer(async (b) => {
    const email = 'log-test@b.example';
    const password = 'S3cretLog!123';
    const r = await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, firstName: 'Log' }) });
    assert.equal(r.status, 201);

    // Le logger ecrit via un stream (asynchrone) : on attend que la ligne soit
    // sur le disque en se calant sur l'email, avant de verifier le mot de passe.
    let contenu = '';
    for (let i = 0; i < 20; i++) {
      contenu = fs.readFileSync(process.env.LOG_FILE, 'utf8');
      if (contenu.includes(email)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(contenu.includes(email), 'la ligne de log doit exister');
    assert.ok(!contenu.includes(password), 'le mot de passe ne doit pas apparaitre dans les logs');
  });
});

test.after(() => { for (const f of [process.env.DB_FILE]) try { fs.unlinkSync(f); } catch { /* ok */ } });
