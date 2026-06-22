require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const BATCH_SIZE = 1000;
const TOTAL_ROWS = 200000;

const CATEGORIES = [
  'Electronics', 'Home & Kitchen', 'Sports & Outdoors', 'Books', 'Clothing',
  'Beauty & Personal Care', 'Automotive', 'Toys & Games', 'Grocery', 'Health & Household',
  'Tools & Home Improvement', 'Baby', 'Pet Supplies', 'Office Products', 'Patio, Lawn & Garden',
  'Arts, Crafts & Sewing', 'Jewelry', 'Shoes', 'Watches', 'Luggage',
  'Music & Instruments', 'Software', 'Video Games', 'Movies & TV', 'Industrial & Scientific'
];

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is not defined.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('neon.tech') ? { rejectUnauthorized: false } : false
  });

  try {
    console.log('Connecting to PostgreSQL database...');
    await client.connect();
    console.log('Connected successfully.');

    // 1. Initialize schema if table doesn't exist
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('Applying database schema from schema.sql...');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await client.query(schemaSql);
      console.log('Schema applied successfully.');
    } else {
      console.log('Warning: db/schema.sql not found, skipping schema initialization.');
    }

    // 2. Clear existing products to ensure clean seed
    console.log('Clearing existing products...');
    await client.query('TRUNCATE TABLE products RESTART IDENTITY CASCADE;');
    console.log('Products table cleared.');

    // 3. Insert 200,000 products in batches
    console.log(`Starting to seed ${TOTAL_ROWS} products in batches of ${BATCH_SIZE}...`);
    const startTime = Date.now();

    for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
      const placeholders = [];
      const values = [];
      let valCount = 1;

      for (let j = 0; j < BATCH_SIZE; j++) {
        const index = i + j + 1;
        const name = `Product ${index}`;
        const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
        const price = parseFloat((Math.random() * 990 + 9.99).toFixed(2));
        
        // Spread created_at randomly over the last 2 years (approx 730 days)
        const randomDaysAgo = Math.random() * 730;
        const createdAt = new Date(Date.now() - randomDaysAgo * 24 * 60 * 60 * 1000);
        const updatedAt = createdAt;

        placeholders.push(`($${valCount}, $${valCount + 1}, $${valCount + 2}, $${valCount + 3}, $${valCount + 4})`);
        values.push(name, category, price, createdAt, updatedAt);
        valCount += 5;
      }

      const query = `
        INSERT INTO products (name, category, price, created_at, updated_at)
        VALUES ${placeholders.join(', ')}
      `;

      await client.query(query, values);
      
      // Print progress
      const progressPercent = (((i + BATCH_SIZE) / TOTAL_ROWS) * 100).toFixed(0);
      console.log(`Progress: ${i + BATCH_SIZE} / ${TOTAL_ROWS} (${progressPercent}%)`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Success: Seeded ${TOTAL_ROWS} products in ${duration} seconds.`);

  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

seed();
