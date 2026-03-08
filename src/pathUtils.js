// Path traversal prevention.
// All functions that write/read user-influenced filenames should call safeJoin
// to ensure the resolved path stays within the expected base directory.

import path from 'path';

/**
 * Resolves `parts` relative to `base` and verifies the result stays within `base`.
 * Uses lexical normalization — fast and suitable for filenames that don't require
 * symlink resolution (mod files are written by the manager itself, not symlinked).
 *
 * Throws an Error if the resolved path would escape `base`.
 * Returns the safe resolved path string.
 */
export function safeJoin(base, ...parts) {
  const normalBase = path.resolve(base);
  const resolved = path.resolve(base, ...parts);

  // The resolved path must be the base itself OR start with base + separator.
  if (resolved !== normalBase && !resolved.startsWith(normalBase + path.sep)) {
    throw new Error(
      `Path traversal blocked: "${parts.join('/')}" resolves outside "${base}"`,
    );
  }

  return resolved;
}
