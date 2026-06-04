/**
 * Integration API keys stored in app_settings ({service}_api_key).
 */

const pool = require('./index');

function settingKey(service) {
  return `${service}_api_key`;
}

async function getCredential(service) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = $1`,
    [settingKey(service)]
  );
  return rows[0]?.value || null;
}

async function upsertCredential(service, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [settingKey(service), value]
  );
}

async function listCredentials() {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key ~ '_api_key$' ORDER BY key`
  );
  return rows.map((row) => ({
    service: row.key.replace(/_api_key$/, ''),
    configured: !!row.value,
  }));
}

module.exports = { getCredential, upsertCredential, listCredentials };
