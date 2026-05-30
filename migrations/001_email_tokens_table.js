/**
 * Migration: Create email_tokens table for magic link passwordless auth
 * 
 * Why TIMESTAMPTZ (Timestamp with Time Zone)?
 * - Neon Postgres always stores in UTC internally
 * - TIMESTAMPTZ makes timezone info explicit in the protocol
 * - Prevents skew issues on Render where server clock might differ from DB
 * - NOW() comparisons always work correctly regardless of server timezone
 */

module.exports = {
  name: 'create_email_tokens_table',
  
  up: async (client) => {
    // Create email_tokens table for magic links / passwordless auth
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL UNIQUE,
        used BOOLEAN DEFAULT FALSE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        consumed_at TIMESTAMPTZ,
        consumed_ip_address VARCHAR(50)
      );
    `);

    // Index: find valid tokens by hash (for verification)
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_tokens_token_idx 
      ON email_tokens(token, used, expires_at)
      WHERE used = FALSE;
    `);

    // Index: find user's tokens (for cleanup/audit)
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_tokens_user_id_idx 
      ON email_tokens(user_id, created_at DESC);
    `);

    // Index: find expired tokens (for cleanup jobs)
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_tokens_expires_at_idx 
      ON email_tokens(expires_at)
      WHERE used = FALSE;
    `);

    console.log('[Migration] ✅ email_tokens table created with TIMESTAMPTZ expiry');
  }
};
