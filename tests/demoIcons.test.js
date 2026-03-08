// Integration tests for demo mod icon URLs.
// These tests hit the real Modrinth API to catch broken project IDs and bad icon URLs
// before they reach the browser. Requires network access.
//
// Run with: node --test tests/demoIcons.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_MODS, DEMO_BROWSE_RESULTS, enrichDemoIcons } from '../src/demoData.js';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const UA = { 'User-Agent': 'minecraft-manager/1.0 (test)', Accept: 'application/json' };

// ---- Offline structure checks ----

test('DEMO_MODS: entries with _projectId have a non-empty string', () => {
  for (const mod of DEMO_MODS) {
    if (mod._projectId === null) continue;
    assert.equal(typeof mod._projectId, 'string', `${mod.filename}: _projectId must be a string or null`);
    assert.ok(mod._projectId.length > 0, `${mod.filename}: _projectId is an empty string`);
  }
});

test('DEMO_BROWSE_RESULTS: all hits have a non-empty project_id', () => {
  for (const hit of DEMO_BROWSE_RESULTS.hits) {
    assert.equal(typeof hit.project_id, 'string', `${hit.slug}: project_id must be a string`);
    assert.ok(hit.project_id.length > 0, `${hit.slug}: project_id is empty`);
  }
});

test('no duplicate project IDs across demo mods', () => {
  const ids = DEMO_MODS.filter(m => m._projectId).map(m => m._projectId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `Duplicate _projectId values: ${dupes.join(', ')}`);
});

// ---- Network: Modrinth API validates all project IDs ----

test('Modrinth API: all demo mod project IDs exist and have icon URLs', { timeout: 30_000 }, async () => {
  const ids = [...new Set(DEMO_MODS.filter(m => m._projectId).map(m => m._projectId))];

  const params = new URLSearchParams({ ids: JSON.stringify(ids) });
  const res = await fetch(`${MODRINTH_API}/projects?${params}`, { headers: UA });
  assert.equal(res.status, 200, `Modrinth API returned HTTP ${res.status}`);

  const projects = await res.json();
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));

  const missing = ids.filter(id => !byId[id]);
  assert.deepEqual(missing, [], `Project ID(s) not found on Modrinth: ${missing.join(', ')}`);

  for (const project of projects) {
    assert.ok(
      project.icon_url,
      `Project ${project.slug} (${project.id}) has no icon_url on Modrinth`,
    );
    assert.ok(
      project.icon_url.startsWith('https://'),
      `Project ${project.slug} icon_url is not HTTPS: ${project.icon_url}`,
    );
  }
});

test('Modrinth API: all browse result project IDs exist and have icon URLs', { timeout: 30_000 }, async () => {
  const ids = [...new Set(DEMO_BROWSE_RESULTS.hits.map(h => h.project_id))];

  const params = new URLSearchParams({ ids: JSON.stringify(ids) });
  const res = await fetch(`${MODRINTH_API}/projects?${params}`, { headers: UA });
  assert.equal(res.status, 200, `Modrinth API returned HTTP ${res.status}`);

  const projects = await res.json();
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));

  const missing = ids.filter(id => !byId[id]);
  assert.deepEqual(missing, [], `Browse result project ID(s) not found on Modrinth: ${missing.join(', ')}`);

  for (const project of projects) {
    assert.ok(
      project.icon_url,
      `Browse result ${project.slug} (${project.id}) has no icon_url on Modrinth`,
    );
    assert.ok(
      project.icon_url.startsWith('https://'),
      `Browse result ${project.slug} icon_url is not HTTPS: ${project.icon_url}`,
    );
  }
});

// ---- Network: enrichDemoIcons() populates valid URLs ----

test('enrichDemoIcons: mods with a project ID get a valid HTTPS icon URL', { timeout: 30_000 }, async () => {
  await enrichDemoIcons();

  for (const mod of DEMO_MODS) {
    if (!mod._projectId) continue; // null = intentionally no Modrinth entry
    const url = mod.modrinthData.iconUrl;
    assert.ok(url, `After enrichment, ${mod.filename} (${mod._projectId}) still has no iconUrl`);
    assert.ok(
      url.startsWith('https://'),
      `After enrichment, ${mod.filename} iconUrl is not HTTPS: ${url}`,
    );
  }
});

test('enrichDemoIcons: browse results get a valid HTTPS icon URL', { timeout: 30_000 }, async () => {
  await enrichDemoIcons();

  for (const hit of DEMO_BROWSE_RESULTS.hits) {
    const url = hit.icon_url;
    assert.ok(url, `After enrichment, browse result ${hit.slug} (${hit.project_id}) has no icon_url`);
    assert.ok(
      url.startsWith('https://'),
      `After enrichment, browse result ${hit.slug} icon_url is not HTTPS: ${url}`,
    );
  }
});

// ---- Network: all enriched icon URLs actually respond with 200 ----

test('enriched icon URLs are reachable (HTTP 200)', { timeout: 60_000 }, async () => {
  await enrichDemoIcons();

  // Collect unique URLs with a label for error messages
  const seen = new Set();
  const urls = [];
  for (const mod of DEMO_MODS) {
    const url = mod.modrinthData.iconUrl;
    if (url && !seen.has(url)) { seen.add(url); urls.push({ url, label: mod.filename }); }
  }
  for (const hit of DEMO_BROWSE_RESULTS.hits) {
    const url = hit.icon_url;
    if (url && !seen.has(url)) { seen.add(url); urls.push({ url, label: hit.slug }); }
  }

  // HEAD-check all URLs in parallel
  const results = await Promise.all(
    urls.map(async ({ url, label }) => {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        return { label, url, ok: res.ok, status: res.status };
      } catch (err) {
        return { label, url, ok: false, status: 0, error: err.message };
      }
    }),
  );

  const failures = results.filter(r => !r.ok);
  assert.equal(
    failures.length,
    0,
    `${failures.length} icon URL(s) are unreachable:\n` +
      failures.map(f => `  ${f.label}: ${f.url} → HTTP ${f.status}${f.error ? ` (${f.error})` : ''}`).join('\n'),
  );
});
