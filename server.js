require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Postgres Connection Pool
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL environment variable is not defined.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('neon.tech') ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helpers for base64 cursor encoding/decoding
function encodeCursor(createdAt, id) {
  const data = JSON.stringify({ createdAt, id });
  return Buffer.from(data).toString('base64');
}

function decodeCursor(cursorStr) {
  try {
    const jsonStr = Buffer.from(cursorStr, 'base64').toString('utf8');
    const obj = JSON.parse(jsonStr);
    if (!obj.createdAt || !obj.id) return null;
    return obj;
  } catch (err) {
    return null;
  }
}

/**
 * GET /products
 * Query Params:
 *  - category: string (optional)
 *  - limit: number (optional, default 20, max 100)
 *  - cursor: base64 string (optional)
 */
app.get('/products', async (req, res) => {
  let { category, limit, cursor } = req.query;

  // Parse and validate limit
  let parsedLimit = parseInt(limit, 10);
  if (isNaN(parsedLimit) || parsedLimit <= 0) {
    parsedLimit = 20;
  } else if (parsedLimit > 100) {
    parsedLimit = 100;
  }

  // Parse and validate cursor
  let cursorData = null;
  if (cursor) {
    cursorData = decodeCursor(cursor);
    if (!cursorData) {
      return res.status(400).json({ error: 'Invalid cursor format' });
    }
  }

  try {
    let queryText = '';
    const params = [];

    // We fetch limit + 1 rows to see if there is another page
    const fetchLimit = parsedLimit + 1;

    if (category) {
      params.push(category);
      if (cursorData) {
        // Category + Keyset Pagination (subsequent pages)
        params.push(new Date(cursorData.createdAt), cursorData.id, fetchLimit);
        queryText = `
          SELECT id, name, category, price, created_at, updated_at
          FROM products
          WHERE category = $1
            AND (created_at, id) < ($2, $3)
          ORDER BY created_at DESC, id DESC
          LIMIT $4;
        `;
      } else {
        // Category + Keyset Pagination (first page)
        params.push(fetchLimit);
        queryText = `
          SELECT id, name, category, price, created_at, updated_at
          FROM products
          WHERE category = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2;
        `;
      }
    } else {
      if (cursorData) {
        // Global Keyset Pagination (subsequent pages)
        params.push(new Date(cursorData.createdAt), cursorData.id, fetchLimit);
        queryText = `
          SELECT id, name, category, price, created_at, updated_at
          FROM products
          WHERE (created_at, id) < ($1, $2)
          ORDER BY created_at DESC, id DESC
          LIMIT $3;
        `;
      } else {
        // Global Keyset Pagination (first page)
        params.push(fetchLimit);
        queryText = `
          SELECT id, name, category, price, created_at, updated_at
          FROM products
          ORDER BY created_at DESC, id DESC
          LIMIT $1;
        `;
      }
    }

    const { rows } = await pool.query(queryText, params);

    // Check if there is a next page
    const hasMore = rows.length > parsedLimit;
    const data = hasMore ? rows.slice(0, parsedLimit) : rows;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.created_at, lastRow.id);
    }

    res.json({
      data,
      next_cursor: nextCursor
    });

  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /categories
 * Returns a sorted list of unique categories
 */
app.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT category FROM products ORDER BY category ASC;');
    const categories = rows.map(r => r.category);
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
