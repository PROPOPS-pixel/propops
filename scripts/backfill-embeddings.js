/**
 * Backfill embeddings for existing hugo_training_data rows.
 *
 * Runs once after deploying migration 048_hugo_brain_vector_search.
 * Loops all rows without an embedding, generates text-embedding-3-small
 * vectors via the OpenAI proxy, and writes them back.
 *
 * Usage: DATABASE_URL=... OPENAI_API_KEY=... OPENAI_BASE_URL=... node scripts/backfill-embeddings.js
 *
 * ~460 rows @ ~100ms each = ~2 minutes, fractions of a cent.
 * Safe to re-run — skips rows that already have an embedding.
 */

require('dotenv').config();
const { Pool } = require('pg');
const OpenAI = require('openai');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const openai = new OpenAI();

async function getEmbedding(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 4000),
  });
  return res.data[0].embedding;
}

async function main() {
  console.log('[Backfill] Starting embedding backfill for hugo_training_data...');

  // Check extension is available
  try {
    await pool.query(`SELECT '[1,2,3]'::vector`);
  } catch (e) {
    console.error('[Backfill] ERROR: pgvector extension not installed. Run migration 048 first.');
    process.exit(1);
  }

  // Count rows needing backfill
  const countRow = await pool.query(`SELECT COUNT(*) as n FROM hugo_training_data WHERE embedding IS NULL`);
  const total = parseInt(countRow.rows[0].n, 10);
  console.log(`[Backfill] ${total} rows need embeddings`);

  if (total === 0) {
    console.log('[Backfill] All rows already have embeddings. Done!');
    await pool.end();
    return;
  }

  // Process in batches of 10 (rate-limit friendly)
  let processed = 0;
  let errors = 0;

  while (true) {
    const rows = await pool.query(
      `SELECT id, customer_message, ai_response FROM hugo_training_data
       WHERE embedding IS NULL ORDER BY id LIMIT 10`
    );

    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      try {
        const aiResp = (() => {
          try { const p = JSON.parse(row.ai_response); return p.hugo_response || p.message || row.ai_response; } catch { return row.ai_response; }
        })();
        const embedText = `${row.customer_message} ${aiResp}`.slice(0, 4000);
        const embedding = await getEmbedding(embedText);
        const embeddingStr = `[${embedding.join(',')}]`;
        await pool.query(
          `UPDATE hugo_training_data SET embedding = $1::vector WHERE id = $2`,
          [embeddingStr, row.id]
        );
        processed++;
        if (processed % 50 === 0) {
          console.log(`[Backfill] Progress: ${processed}/${total} (${Math.round(processed/total*100)}%)`);
        }
        // Small delay to be polite to the API
        await new Promise(r => setTimeout(r, 50));
      } catch (err) {
        errors++;
        console.warn(`[Backfill] Error on row ${row.id}: ${err.message}`);
        if (errors > 20) {
          console.error('[Backfill] Too many errors, stopping');
          break;
        }
      }
    }

    if (errors > 20) break;
  }

  console.log(`[Backfill] Complete! Processed: ${processed}, Errors: ${errors}`);
  await pool.end();
}

main().catch(err => {
  console.error('[Backfill] Fatal error:', err.message);
  process.exit(1);
});
