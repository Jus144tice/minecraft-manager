// Modrinth API v2 wrapper
// Docs: https://docs.modrinth.com/api/
import crypto from 'crypto';

const BASE = 'https://api.modrinth.com/v2';
const HEADERS = {
  'User-Agent': 'minecraft-manager/1.0 (home-server-panel)',
  'Accept': 'application/json',
};

async function modrinthFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { ...HEADERS, ...options.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Modrinth API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Search for mods on Modrinth.
 * Always excludes client-only mods (server_side:unsupported) — these cannot run on a server.
 * @param {string} query - Search term
 * @param {object} opts
 * @param {string} opts.mcVersion - e.g. "1.20.1"
 * @param {string} opts.loader - e.g. "forge"
 * @param {string} opts.side - "server" | "both" | "all"  (client-only is never shown)
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @param {string} opts.index - "relevance" | "downloads" | "follows" | "newest" | "updated"
 */
export async function searchMods(query, { mcVersion, loader = 'forge', side = 'all', limit = 20, offset = 0, index = 'relevance' } = {}) {
  const facets = [['project_type:mod']];

  if (loader) facets.push([`categories:${loader}`]);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);

  // Always exclude client-only mods — they cannot be installed on a server
  // server_side must be required, optional, or unknown (not unsupported)
  facets.push(['server_side:required', 'server_side:optional', 'server_side:unknown']);

  if (side === 'server') {
    // Server-only: client_side is unsupported
    facets.push(['client_side:unsupported']);
  } else if (side === 'both') {
    // Must work on both: client_side is required or optional AND server_side already filtered above
    facets.push(['client_side:required', 'client_side:optional']);
  }
  // side === 'all': just the server_side filter above is enough

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(limit),
    offset: String(offset),
    index,
  });

  return modrinthFetch(`/search?${params}`);
}

/**
 * Get a project by slug or ID
 */
export async function getProject(idOrSlug) {
  return modrinthFetch(`/project/${idOrSlug}`);
}

/**
 * Get versions for a project, filtered by loader and MC version
 */
export async function getProjectVersions(idOrSlug, { mcVersion, loader = 'forge' } = {}) {
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
  return modrinthFetch(`/project/${idOrSlug}/version?${params}`);
}

/**
 * Look up installed mods by their SHA1 hashes.
 * Returns a map of hash -> { version, project } objects.
 */
export async function lookupByHashes(hashes) {
  if (hashes.length === 0) return {};

  const versions = await modrinthFetch('/version_files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes, algorithm: 'sha1' }),
  });

  // versions is { [sha1]: versionObject }
  // Fetch project metadata for each unique project_id to get client_side/server_side
  const projectIds = [...new Set(Object.values(versions).map(v => v.project_id))];
  let projects = {};

  if (projectIds.length > 0) {
    // Batch fetch - up to 500 at once per Modrinth docs
    const chunks = [];
    for (let i = 0; i < projectIds.length; i += 500) chunks.push(projectIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const params = new URLSearchParams({ ids: JSON.stringify(chunk) });
      const list = await modrinthFetch(`/projects?${params}`);
      for (const p of list) projects[p.id] = p;
    }
  }

  // Combine version + project data
  const result = {};
  for (const [hash, version] of Object.entries(versions)) {
    const project = projects[version.project_id] || {};
    result[hash] = {
      projectId: version.project_id,
      projectSlug: project.slug,
      projectTitle: project.title,
      projectDescription: project.description,
      versionId: version.id,
      versionName: version.name,
      versionNumber: version.version_number,
      gameVersions: version.game_versions,
      loaders: version.loaders,
      clientSide: project.client_side || 'unknown',
      serverSide: project.server_side || 'unknown',
      iconUrl: project.icon_url || null,
    };
  }
  return result;
}

/**
 * Get a specific version object (has file download URLs and hashes)
 */
export async function getVersion(versionId) {
  return modrinthFetch(`/version/${versionId}`);
}

/**
 * Resolve best matching version for a project given constraints.
 * Returns the version object or null.
 */
export async function resolveBestVersion(projectId, { mcVersion, loader = 'forge' } = {}) {
  try {
    const versions = await getProjectVersions(projectId, { mcVersion, loader });
    if (!versions || versions.length === 0) return null;
    // Prefer release > beta > alpha
    const order = ['release', 'beta', 'alpha'];
    for (const type of order) {
      const v = versions.find(v => v.version_type === type);
      if (v) return v;
    }
    return versions[0];
  } catch {
    return null;
  }
}

/**
 * Download a mod file buffer and verify its SHA1 hash against Modrinth's known-good value.
 * Throws if the hash doesn't match — the file may be corrupted or tampered with.
 * Returns { buffer, filename }
 */
export async function downloadModFile(downloadUrl, filename, expectedSha1) {
  const res = await fetch(downloadUrl, { headers: HEADERS });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (expectedSha1) {
    const actual = crypto.createHash('sha1').update(buf).digest('hex');
    if (actual !== expectedSha1) {
      throw new Error(
        `Hash mismatch for ${filename}: expected ${expectedSha1}, got ${actual}. ` +
        'File may be corrupted or tampered with. Download aborted.',
      );
    }
  }

  return { buffer: buf, filename };
}
