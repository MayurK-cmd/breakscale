/**
 * URL parameter parsing for loading presets from query params.
 *
 * Supported parameters:
 * - preset: Load a specific preset by ID (e.g., ?preset=single-server)
 *
 * This allows direct navigation to specific examples, which is needed for
 * visual regression tests and share links that should load examples directly
 * without relying on localStorage persistence.
 */

import { PRESETS } from './sim/presets';

interface UrlParams {
  presetId: string | null;
}

/**
 * Parse URL query parameters.
 * @returns Object containing presetId, or null if no params found
 */
function parseUrlParams(): UrlParams | null {
  const search = window.location.search.substring(1);
  if (!search) return null;

  const params = new URLSearchParams(search);
  const presetId = params.get('preset');

  // Skip if no params found
  if (!presetId) return null;

  return {
    presetId: presetId || null,
  };
}

/**
 * Load a specific preset by ID.
 * @param presetId - The preset ID to load (e.g., 'single-server')
 * @returns The preset object, or null if not found
 */
export function loadPresetById(
  presetId: string | null,
): ReturnType<typeof PRESETS.find> | null {
  if (!presetId) return null;
  return PRESETS.find((p) => p.id === presetId) || null;
}

/**
 * Get parameters from URL. Returns null if not set.
 */
export function getUrlParams(): UrlParams | null {
  return parseUrlParams();
}

/**
 * Clear URL parameters from the browser URL.
 * This prevents the params from being picked up on each navigation/refresh.
 */
export function clearUrlParams(): void {
  const url = new URL(window.location.toString());
  url.searchParams.delete('preset');
  // Note: We're not clearing 'theme' since the original app doesn't support it
  // in query params (it only reads from hash with d1./d2. prefixes)
  window.history.replaceState(
    {
      ...history.state,
      state: url.hash,
    },
    '',
    url.toString(),
  );
}
