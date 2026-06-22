require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL environment variable is not defined.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('neon.tech') ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Opaque Base64 Cursor helpers
function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64');
}

function decodeCursor(cursorStr) {
  try {
    return JSON.parse(Buffer.from(cursorStr, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * GET /products
 * Supports category filtering and keyset pagination via cursor
 */
app.get('/products', async (req, res) => {
  let { category, limit, cursor } = req.query;

  // Cap limit between 1 and 100 (default 20)
  let parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const cursorData = cursor ? decodeCursor(cursor) : null;

  try {
    const params = [];
    let queryText = 'SELECT id, name, category, price, created_at, updated_at FROM products WHERE 1=1';

    // 1. Conditional Category Filter
    if (category) {
      params.push(category);
      queryText += ` AND category = $${params.length}`;
    }

    // 2. Keyset Pagination Tuple Comparison: (created_at, id) < (cursor_created_at, cursor_id)
    if (cursorData && cursorData.createdAt && cursorData.id) {
      params.push(new Date(cursorData.createdAt), cursorData.id);
      queryText += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
    }

    // 3. Sorting & Limit (fetch limit + 1 to check for next page presence)
    const fetchLimit = parsedLimit + 1;
    params.push(fetchLimit);
    queryText += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length};`;

    const { rows } = await pool.query(queryText, params);

    const hasMore = rows.length > parsedLimit;
    const data = hasMore ? rows.slice(0, parsedLimit) : rows;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.created_at, lastRow.id);
    }

    res.json({ data, next_cursor: nextCursor });

  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /categories
 */
app.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT category FROM products ORDER BY category ASC;');
    res.json({ categories: rows.map(r => r.category) });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
