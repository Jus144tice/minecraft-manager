// Modrinth API v2 wrapper
// Docs: https://docs.modrinth.com/api/
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
 * Search for mods on Modrinth
 * @param {string} query - Search term
 * @param {object} opts
 * @param {string} opts.mcVersion - e.g. "1.20.1"
 * @param {string} opts.loader - e.g. "forge"
 * @param {string} opts.side - "client" | "server" | "both" | "all"
 * @param {number} opts.limit
 * @param {number} opts.offset
 */
export async function searchMods(query, { mcVersion, loader = 'forge', side = 'all', limit = 20, offset = 0 } = {}) {
  const facets = [['project_type:mod']];

  if (loader) facets.push([`categories:${loader}`]);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);

  if (side === 'client') {
    facets.push(['client_side:required', 'client_side:optional']);
    facets.push(['server_side:unsupported']);
  } else if (side === 'server') {
    facets.push(['server_side:required', 'server_side:optional']);
    facets.push(['client_side:unsupported']);
  } else if (side === 'both') {
    facets.push(['client_side:required', 'client_side:optional']);
    facets.push(['server_side:required', 'server_side:optional']);
  }

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(limit),
    offset: String(offset),
    index: 'relevance',
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
 * Get a specific version object (has file download URLs)
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
 * Download a mod file buffer given a version's file object.
 * Returns { buffer, filename }
 */
export async function downloadModFile(downloadUrl, filename) {
  const res = await fetch(downloadUrl, { headers: HEADERS });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, filename };
}
