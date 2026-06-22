require('dotenv').config();
const { Client } = require('pg');

const PAGE_SIZE = 1000;
const CONCURRENT_INSERTS = 50;
const CONCURRENT_UPDATES = 50;

async function runSimulation() {
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
    await client.connect();
    console.log('Connected to database for pagination correctness proof.');

    // Fetch total row count to check if seeded
    const countRes = await client.query('SELECT count(*) FROM products');
    const totalCount = parseInt(countRes.rows[0].count, 10);
    console.log(`Current products in DB: ${totalCount}`);

    if (totalCount < 5000) {
      console.error('Error: Database has too few records to run a meaningful simulation. Please run seed script first.');
      process.exit(1);
    }

    // Pick 50 random products that currently exist in the database (we will float them to top)
    const existingRes = await client.query(`
      SELECT id, created_at, updated_at 
      FROM products 
      ORDER BY created_at DESC 
      LIMIT 100 OFFSET 1000;
    `);
    const targetProducts = existingRes.rows.slice(0, CONCURRENT_UPDATES);
    const targetIds = targetProducts.map(p => p.id);

    console.log(`Selected ${CONCURRENT_UPDATES} existing products to modify during the walks.`);

    // Keep track of new products inserted so we can clean them up
    let insertedIds = [];

    // Helper functions for simulation writes
    async function performConcurrentWrites() {
      console.log('\n--- Simulating Concurrent Writes (50 new inserts, 50 floating updates) ---');
      
      // 1. Insert 50 brand-new products with latest timestamp
      const insertPlaceholders = [];
      const insertValues = [];
      let valCount = 1;
      const now = new Date();

      for (let i = 0; i < CONCURRENT_INSERTS; i++) {
        insertPlaceholders.push(`($${valCount}, $${valCount + 1}, $${valCount + 2}, $${valCount + 3}, $${valCount + 4})`);
        insertValues.push(
          `Concurrently Inserted Product ${i + 1}`,
          'Electronics',
          99.99,
          new Date(now.getTime() + i * 1000), // unique slightly future timestamps to guarantee they float to the top
          new Date(now.getTime() + i * 1000)
        );
        valCount += 5;
      }

      const insertRes = await client.query(`
        INSERT INTO products (name, category, price, created_at, updated_at)
        VALUES ${insertPlaceholders.join(', ')}
        RETURNING id;
      `, insertValues);
      
      insertedIds = insertRes.rows.map(r => r.id);
      console.log(`Inserted ${insertedIds.length} new products at the top.`);

      // 2. Update 50 existing products to have latest timestamps (floated to top)
      for (let i = 0; i < targetProducts.length; i++) {
        const product = targetProducts[i];
        // Give them a timestamp slightly newer than the rest
        const newCreatedAt = new Date(now.getTime() + (CONCURRENT_INSERTS + i) * 1000);
        await client.query(
          'UPDATE products SET created_at = $1, updated_at = $2 WHERE id = $3',
          [newCreatedAt, newCreatedAt, product.id]
        );
      }
      console.log(`Updated (floated) ${targetProducts.length} existing products to the top.`);
      console.log('--- Concurrent Writes Complete ---\n');
    }

    async function restoreDatabase() {
      console.log('Restoring database state...');
      
      // 1. Delete the concurrently inserted products
      if (insertedIds.length > 0) {
        await client.query('DELETE FROM products WHERE id = ANY($1)', [insertedIds]);
      }

      // 2. Restore the original created_at/updated_at timestamps of modified products
      for (const origProduct of targetProducts) {
        await client.query(
          'UPDATE products SET created_at = $1, updated_at = $2 WHERE id = $3',
          [origProduct.created_at, origProduct.updated_at, origProduct.id]
        );
      }
      console.log('Database state successfully restored.');
    }

    // ==========================================
    // TEST 1: OFFSET-based pagination
    // ==========================================
    async function runOffsetWalk() {
      console.log('Starting Walk 1: OFFSET-based Pagination...');
      const seenIds = [];
      const seenCountMap = new Map();
      let offset = 0;
      let page = 1;
      let writesPerformed = false;

      while (true) {
        // Read page
        const res = await client.query(
          'SELECT id FROM products ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
          [PAGE_SIZE, offset]
        );

        if (res.rows.length === 0) break;

        for (const row of res.rows) {
          seenIds.push(row.id);
          seenCountMap.set(row.id, (seenCountMap.get(row.id) || 0) + 1);
        }

        // Simulate write after reading 5 pages
        if (page === 5 && !writesPerformed) {
          await performConcurrentWrites();
          writesPerformed = true;
        }

        offset += PAGE_SIZE;
        page++;
      }

      // Restore DB for the next walk
      await restoreDatabase();

      return { seenIds, seenCountMap };
    }

    // ==========================================
    // TEST 2: KEYSET-based pagination
    // ==========================================
    async function runKeysetWalk() {
      console.log('Starting Walk 2: KEYSET-based Pagination...');
      const seenIds = [];
      const seenCountMap = new Map();
      let cursor = null;
      let page = 1;
      let writesPerformed = false;

      while (true) {
        let res;
        if (!cursor) {
          // First page
          res = await client.query(`
            SELECT id, created_at 
            FROM products 
            ORDER BY created_at DESC, id DESC 
            LIMIT $1;
          `, [PAGE_SIZE]);
        } else {
          // Subsequent pages
          res = await client.query(`
            SELECT id, created_at 
            FROM products 
            WHERE (created_at, id) < ($1, $2)
            ORDER BY created_at DESC, id DESC 
            LIMIT $3;
          `, [new Date(cursor.createdAt), cursor.id, PAGE_SIZE]);
        }

        if (res.rows.length === 0) break;

        for (const row of res.rows) {
          seenIds.push(row.id);
          seenCountMap.set(row.id, (seenCountMap.get(row.id) || 0) + 1);
        }

        // Set cursor for the next iteration (using the last item of this page)
        const lastRow = res.rows[res.rows.length - 1];
        cursor = { createdAt: lastRow.created_at, id: lastRow.id };

        // Simulate write after reading 5 pages
        if (page === 5 && !writesPerformed) {
          await performConcurrentWrites();
          writesPerformed = true;
        }

        page++;
      }

      // Restore DB at the end
      await restoreDatabase();

      return { seenIds, seenCountMap };
    }

    // Helper to evaluate and print results
    function evaluateResults(name, walkData) {
      const { seenIds, seenCountMap } = walkData;
      let duplicateCount = 0;
      let duplicatesList = [];
      
      for (const [id, count] of seenCountMap.entries()) {
        if (count > 1) {
          duplicateCount += (count - 1);
          duplicatesList.push(id);
        }
      }

      // Untouched products check
      // A product is untouched if it was not in targetIds (modified) and not in insertedIds (newly created).
      // Let's count how many targetIds were skipped
      let skippedUntouchedCount = 0;
      
      // Let's check how many total unique products were seen compared to the expected total
      // Expected: the original products minus targetIds (since they floated to top and might be skipped if we were past page 5,
      // which is correct behavior for pagination since they moved "above" our cursor).
      // What we care about is: did we skip any product that was NOT modified?
      // With OFFSET, since 50 new items were inserted above, the window shifted down.
      // This causes 50 products that we ALREADY saw on page 5 to appear again on page 6 (duplicates).
      // In OFFSET, if items are deleted or shifted, we miss items.
      
      console.log(`\n==============================================`);
      console.log(`RESULTS FOR: ${name}`);
      console.log(`==============================================`);
      console.log(`Total IDs processed in walk: ${seenIds.length}`);
      console.log(`Unique IDs processed in walk: ${seenCountMap.size}`);
      console.log(`Duplicate IDs encountered: ${duplicateCount}`);
      
      if (duplicateCount > 0) {
        console.log(`⚠️ Warning: Duplicate rows were returned during the walk!`);
      } else {
        console.log(`✅ Success: 0 duplicate rows returned.`);
      }

      // Check if we missed any of the floated items
      // When items float to the top, if they were below page 5, they move to the top (which is before page 5).
      // Since they are now at the top, they are "older" than our page 5 cursor (keyset) or offset boundary (offset).
      // In Keyset, we expect to miss the floated items because they are now newer than the cursor. This is CORRECT. We do NOT want to see them again or double count.
      // What is critical is that we did not miss any UNTOUCHED items (items that stayed in their original positions).
      // Let's verify that every single untouched product in the database was visited exactly once.
      // To check this, we check if there are any gaps in the IDs.
      // Let's verify if the keyset walk contains any duplicates (should be 0).
    }

    // Run both walks and compare
    const offsetResult = await runOffsetWalk();
    evaluateResults('OFFSET-based Pagination', offsetResult);

    console.log('\n\n');

    const keysetResult = await runKeysetWalk();
    evaluateResults('KEYSET-based Pagination', keysetResult);

  } catch (error) {
    console.error('Simulation run failed:', error);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

runSimulation();
