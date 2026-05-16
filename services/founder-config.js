/**
 * founder-config.js — cached loader for hugo_founder_config table.
 *
 * Owns: reading founder god-layer config from DB with a short in-memory cache.
 *       Providing pricing locks and global rules to hugo-brain.js.
 * Does NOT own: writing config (that's routes/founder.js), AI persona logic, billing.
 *
 * Cache TTL: 60 seconds — fast enough for real-time feel, cheap enough to not
 * hammer the DB on every Brain request (which can be 10+ per second under load).
 */

const { Pool } = require('pg');

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// In-memory cache: { rows: Map<string, string>, loadedAt: number }
let _cache = null;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Load all founder config rows into a key→value map.
 * Cached for CACHE_TTL_MS. Falls back to empty map on DB error (fail-open).
 * @returns {Promise<Map<string, string>>}
 */
async function loadConfig() {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache.rows;
  }

  try {
    const result = await getPool().query(
      'SELECT config_key, config_value, is_locked FROM hugo_founder_config ORDER BY config_key'
    );
    const map = new Map();
    for (const row of result.rows) {
      map.set(row.config_key, { value: row.config_value, locked: row.is_locked });
    }
    _cache = { rows: map, loadedAt: now };
    return map;
  } catch (err) {
    // Table may not exist yet during first deploy — fail open, use code defaults
    if (!err.message.includes('does not exist')) {
      console.warn('[FounderConfig] Load error (fail-open):', err.message);
    }
    return new Map();
  }
}

/**
 * Get a single config value by key.
 * Returns null if not found.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function getConfigValue(key) {
  const map = await loadConfig();
  return map.get(key)?.value ?? null;
}

/**
 * Build pricing constants from DB config, falling back to code defaults.
 * Used by hugo-brain.js to override hard-coded PRICING_CONSTANTS.
 * @returns {Promise<{ trade: number, pro: number, earlyBirdPro: number, earlyBirdDeadline: string }>}
 */
async function getPricingLocks() {
  const map = await loadConfig();

  const trade         = parseInt(map.get('pricing_lock.propops.trade')?.value || '69', 10);
  const pro           = parseInt(map.get('pricing_lock.propops.pro')?.value   || '99', 10);
  const earlyBirdPro  = parseInt(map.get('pricing_lock.early_bird_pro')?.value || '69', 10);
  const earlyBirdDead = map.get('pricing_lock.early_bird_deadline')?.value || 'June 30, 2026';

  return { trade, pro, earlyBirdPro, earlyBirdDeadline: earlyBirdDead };
}

/**
 * Get all global rules (keys starting with 'global_rule.') as an array of descriptions.
 * Used to inject into Hugo's system prompt.
 * @returns {Promise<string[]>}
 */
async function getGlobalRules() {
  const map = await loadConfig();
  const rules = [];
  for (const [key, entry] of map.entries()) {
    if (key.startsWith('global_rule.') && entry.value === 'true') {
      // Use description if we can, otherwise just key slug
      rules.push(key.replace('global_rule.', '').replace(/_/g, ' '));
    }
  }
  return rules;
}

/**
 * Invalidate the in-memory cache. Call after writing new config rows.
 */
function invalidateCache() {
  _cache = null;
}

/**
 * Get all config rows as a plain array (for API responses).
 * @returns {Promise<Array<{config_key, config_value, description, is_locked, vertical, updated_at}>>}
 */
async function getAllConfig() {
  try {
    const result = await getPool().query(`
      SELECT id, config_key, config_value, description, is_locked, vertical, updated_at
      FROM hugo_founder_config
      ORDER BY config_key
    `);
    return result.rows;
  } catch (err) {
    if (!err.message.includes('does not exist')) {
      console.warn('[FounderConfig] getAllConfig error:', err.message);
    }
    return [];
  }
}

/**
 * Upsert a config row. Only allows updating config_value and description.
 * is_locked rows can still be updated by the founder (that's the point).
 */
async function upsertConfig({ config_key, config_value, description, is_locked, vertical }) {
  invalidateCache();
  const result = await getPool().query(`
    INSERT INTO hugo_founder_config (config_key, config_value, description, is_locked, vertical, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      description  = COALESCE(EXCLUDED.description, hugo_founder_config.description),
      is_locked    = EXCLUDED.is_locked,
      updated_at   = NOW()
    RETURNING *
  `, [config_key, config_value, description || null, is_locked !== false, vertical || null]);
  return result.rows[0];
}

/**
 * Delete a non-seed config row (pricing locks cannot be deleted, only updated).
 */
async function deleteConfig(config_key) {
  invalidateCache();
  // Prevent deletion of core pricing locks
  if (config_key.startsWith('pricing_lock.')) {
    throw new Error('Pricing locks cannot be deleted — update the value instead.');
  }
  const result = await getPool().query(
    'DELETE FROM hugo_founder_config WHERE config_key = $1 RETURNING config_key',
    [config_key]
  );
  return result.rowCount > 0;
}

module.exports = {
  loadConfig,
  getConfigValue,
  getPricingLocks,
  getGlobalRules,
  invalidateCache,
  getAllConfig,
  upsertConfig,
  deleteConfig,
};
