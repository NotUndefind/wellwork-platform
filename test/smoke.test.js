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

test('consentements non pre-coches a l inscription', async () => {
  await withServer(async (b) => {
    // 1. Inscription SANS aucun choix de consentement -> tout doit etre false.
    const r = await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'consent-off@b.example', password: 'x' }) });
    assert.equal(r.status, 201);
    const { user } = await r.json();
    assert.equal(user.marketingOptIn, false);

    const data = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
    const consent = data.consents.find((c) => c.userId === user.id);
    assert.ok(consent, 'un enregistrement de consentement doit exister');
    assert.equal(consent.marketing, false);
    assert.equal(consent.thirdParty, false);

    // 2. Inscription AVEC choix explicite -> le consentement reste possible.
    const r2 = await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'consent-on@b.example', password: 'x', marketingOptIn: true, thirdParty: true }) });
    const { user: user2 } = await r2.json();
    const data2 = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
    const consent2 = data2.consents.find((c) => c.userId === user2.id);
    assert.equal(consent2.marketing, true);
    assert.equal(consent2.thirdParty, true);
  });
});

test('passwordHash absent des reponses de l API', async () => {
  await withServer(async (b) => {
    const creds = { email: 'nohash@b.example', password: 'Secret1' };

    // register
    const reg = await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) });
    const { token, user } = await reg.json();
    assert.ok(!('passwordHash' in user), 'register ne doit pas renvoyer passwordHash');

    // login
    const login = await j(await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) }));
    assert.ok(!('passwordHash' in login.user), 'login ne doit pas renvoyer passwordHash');

    const auth = { authorization: `Bearer ${token}` };

    // GET /me
    const me = await j(await fetch(`${b}/api/me`, { headers: auth }));
    assert.ok(!('passwordHash' in me), 'me ne doit pas renvoyer passwordHash');
    assert.equal(me.email, creds.email); // les champs utiles restent presents

    // GET /users/:id
    const one = await j(await fetch(`${b}/api/users/${user.id}`, { headers: auth }));
    assert.ok(!('passwordHash' in one), 'users/:id ne doit pas renvoyer passwordHash');
    assert.ok('questionnaires' in one, 'users/:id garde les questionnaires');

    // GET /users (annuaire)
    const list = await j(await fetch(`${b}/api/users?filter=true`, { headers: auth }));
    assert.ok(Array.isArray(list) && list.length > 0);
    assert.ok(list.every((u) => !('passwordHash' in u)), 'users ne doit exposer aucun passwordHash');
  });
});

test('mass assignment impossible sur PATCH /me', async () => {
  await withServer(async (b) => {
    const reg = await j(await fetch(`${b}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'patch@b.example', password: 'x', firstName: 'Avant' }) }));
    const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' };

    // Tentative d'elevation de privilege + modif d'un champ legitime dans la meme requete.
    const patched = await j(await fetch(`${b}/api/me`, { method: 'PATCH', headers: auth, body: JSON.stringify({ role: 'admin', firstName: 'Apres' }) }));
    assert.equal(patched.role, 'employee'); // le role ne doit PAS avoir change
    assert.equal(patched.firstName, 'Apres'); // mais le champ autorise est bien applique

    // Confirmation apres relecture du profil.
    const me = await j(await fetch(`${b}/api/me`, { headers: { authorization: `Bearer ${reg.token}` } }));
    assert.equal(me.role, 'employee');
  });
});

test.after(() => { for (const f of [process.env.DB_FILE]) try { fs.unlinkSync(f); } catch { /* ok */ } });
