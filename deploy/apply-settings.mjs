#!/usr/bin/env node
// Idempotent desired-state applier for dsh-superagent settings.
// Run on the container:  node deploy/apply-settings.mjs
// Reads deploy/settings.desired.json; deep-merges each block over the current
// value; PUTs only when something actually changed (revision-conflict safe:
// re-reads and retries once). Then runs setup/check when a setup problem waits,
// and waits for the runtime to report ready.
import { readFileSync } from 'node:fs';

const api = 'http://127.0.0.1:3082/orchestrator/api';
const H = { 'x-orchestrator-request': '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const desired = JSON.parse(readFileSync(new URL('./settings.desired.json', import.meta.url), 'utf8'));

function merge(base, over) {
  if (Array.isArray(over) || over === null || typeof over !== 'object') return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base?.[k], v);
  return out;
}
function changed(base, merged) {
  return JSON.stringify(base) !== JSON.stringify(merged);
}

async function jget(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

await (async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${api}/state`, { headers: H }); if (r.ok) return; } catch {}
    await sleep(2000);
  }
  throw new Error('management API did not come up within 120s');
})();

const settings = await jget(`${api}/settings`);

for (const [key, want] of Object.entries(desired)) {
  if (key.startsWith('source:')) {
    const id = key.slice('source:'.length);
    const src = settings.sources.find((s) => s.id === id);
    if (!src) throw new Error(`no such source instance: ${id}`);
    const merged = { enabled: src.enabled, config: merge(src.config ?? {}, want.config ?? {}) };
    if (want.enabled !== undefined) merged.enabled = want.enabled;
    if (!changed({ enabled: src.enabled, config: src.config }, merged)) {
      console.log(`${key}: unchanged`);
      continue;
    }
    const r = await fetch(`${api}/settings/${key}`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ value: merged, revision: src.revision }),
    });
    const out = await r.json().catch(() => ({}));
    console.log(`${key}: PUT ${r.status}`, JSON.stringify(out));
    if (!r.ok) throw new Error(`${key} save failed: ${JSON.stringify(out)}`);
    if (out.restarting) { console.log(`${key}: app restarting; waiting…`); await waitUp(); }
  } else {
    const block = settings.blocks[key];
    if (!block) throw new Error(`no such settings block: ${key}`);
    const merged = merge(block.value, want);
    if (!changed(block.value, merged)) {
      console.log(`${key}: unchanged`);
      continue;
    }
    const r = await fetch(`${api}/settings/${key}`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ value: merged, revision: block.revision }),
    });
    const out = await r.json().catch(() => ({}));
    console.log(`${key}: PUT ${r.status}`, JSON.stringify(out));
    if (!r.ok) throw new Error(`${key} save failed: ${JSON.stringify(out)}`);
  }
}

const state = await jget(`${api}/state`);
if (state.setup?.problem) {
  console.log('setup problem:', JSON.stringify(state.setup.problem));
  const r = await fetch(`${api}/setup/check`, { method: 'POST', headers: H });
  console.log('setup/check:', r.status, JSON.stringify(await r.json().catch(() => ({}))));
  if (!r.ok) {
    console.log('setup check refused; inspect the problem above.');
    process.exit(2);
  }
}

for (let i = 0; i < 90; i++) {
  await sleep(2000);
  try {
    const st = await jget(`${api}/state`);
    if (st.health?.runtime?.state === 'ready' || st.health?.runtime === 'ready') {
      console.log('runtime READY; setup problem:', JSON.stringify(st.setup?.problem ?? null));
      console.log('accounts:', JSON.stringify(st.setup?.accounts ?? null));
      console.log('health:', JSON.stringify(st.health));
      process.exit(0);
    }
    console.log('waiting… runtime=', st.health?.runtime ?? '?', 'setup=', st.setup?.problem?.code ?? '-');
  } catch { console.log('restarting…'); }
}
console.log('NOT ready after 180s');
process.exit(1);
