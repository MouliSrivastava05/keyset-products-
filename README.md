# Keyset Pagination Product Portal

This project is a small, production-grade backend demonstrating **Keyset (Cursor) Pagination** over a PostgreSQL database containing **200,000 products**. It is designed to be extremely fast and mathematically correct even under concurrent writes (updates and inserts).

---

## How to Setup & Run

### 1. Configure the Environment
Create a `.env` file in the root directory by copying `.env.example`:
```bash
cp .env.example .env
```
Open `.env` and configure your `DATABASE_URL` (local PostgreSQL instance or Neon DB URL) and `PORT`.

### 2. Seed the Database
Run the seed script. This will automatically execute `db/schema.sql` to initialize/refresh the table and indexes, and then insert 200,000 records in parameterized batches of 1,000 rows. It finishes in seconds:
```bash
npm run seed
```

### 3. Run the Server
Start the Express server in development mode (using nodemon) or standard mode:
```bash
# Start dev server
npm run dev

# Or start standard server
npm run start
```
Once started, open your browser and navigate to `http://localhost:3000` to interact with the premium Web UI.

### 4. Run the Correctness Proof Simulation
To verify the concurrent write assertions, run the simulation script:
```bash
npm run simulate
```

---

## Technical Architecture

### 1. What I Built
Instead of standard `OFFSET`/`LIMIT` pagination, this backend uses **Keyset (Cursor-based) Pagination** ordered by `(created_at DESC, id DESC)`.

* **OFFSET Pagination (`SELECT ... LIMIT 20 OFFSET 100000`)**:
  * **Speed Penalty**: To return the 100,000th page, the database engine must scan and discard the first 100,000 records. Query times degrade linearly as pages get deeper ($O(N)$).
  * **Correctness Penalty**: If a new product is added at the top while a user is reading, all items shift down by 1 index. The user will see a product they already saw on the previous page (duplicate). If a product is updated or deleted, items shift up, causing the user to skip a product completely.
* **Keyset Pagination (`SELECT ... WHERE (created_at, id) < (cursor_created_at, cursor_id) ORDER BY ...`)**:
  * **Speed**: The database uses a composite index to jump directly to the first record matching the cursor's coordinates. It performs an index range scan rather than scanning the table. Fetching the last page takes the same amount of time as the first ($O(\log N)$).
  * **Correctness**: The search window is anchored to the value of the last item seen. Concurrent inserts or updates above the cursor do not affect the relative ordering of the remaining older items. Every untouched product is guaranteed to be returned exactly once.

### 2. Lexicographical Tuple Comparison
The query:
```sql
SELECT * FROM products
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```
uses Postgres' native support for tuple comparison. It evaluates as:
`created_at < $1 OR (created_at = $1 AND id < $2)`

Using `id` as the second column breaks ties deterministically when multiple products share identical `created_at` timestamps (which is highly likely at scale or during bulk insertions).

### 3. Index Design Trade-offs
To support $O(\log N)$ reads, I created two composite indexes:
1. `idx_products_created_id` ON `products (created_at DESC, id DESC)` for global browsing.
2. `idx_products_category_created_id` ON `products (category, created_at DESC, id DESC)` for category-filtered browsing.

**Trade-offs**:
* **More Disk Space & Slower Writes**: Every product write (INSERT/UPDATE/DELETE) must now update two additional indexes.
* **Why it's worth it**: For a typical product catalog, reads outweigh writes by orders of magnitude. The overhead on insertion is tiny (adding 200k records still takes under 15 seconds), while reading deep pages changes from a slow, heap-scanning database query (~100ms+) to a direct index lookup (< 2ms).

---

## What I'd Improve with More Time

1. **Tamper-proof Cursors**:
   Currently, cursors are simple JSON base64-encoded strings: `Buffer.from(JSON.stringify({createdAt, id})).toString('base64')`. A client could manually forge cursors. In production, I would sign the cursor using an HMAC (using a secret key) or encrypt it, so the server can reject tampered cursors.
2. **Covering Indexes (`INCLUDE`)**:
   I could use the `INCLUDE` clause in Postgres to include product columns (e.g. name, price) directly in the index structure. This allows **Index-Only Scans**, fetching the product details directly from the index tree without having to perform heap lookups for the actual table row page.
3. **API Rate Limiting & Concurrency Tuning**:
   Add rate limiting to the `/products` endpoint to prevent scraping and abuse.
4. **Elasticsearch / Search Index Integration**:
   For complex filters (e.g. multi-select categories, full-text searches on product name, price ranges), relational indexes become complex. I would sync the database to Elasticsearch or Algolia to handle rich searches while retaining cursor pagination.

---

## How I Used AI

1. **Discrepancy Correction**:
   I noticed a contradiction in the requirements: one sentence suggested using **MongoDB**, but all technical instructions (UUIDs, schema.sql, Neon DB, and PostgreSQL tuple comparison operators) specified **PostgreSQL**. I chose PostgreSQL because it supports index-backed tuple comparison natively and cleanly.
2. **Scaffolding the Correctness Simulation**:
   I asked the AI to write a dual walk script. Instead of just verifying keyset pagination, we built a script that runs the exact same write scenario (50 inserts, 50 updates) on both OFFSET and KEYSET paging styles. This physically demonstrates the duplicate row bug in OFFSET paging and visually proves why KEYSET pagination works.
3. **Scaffolding the Premium Web UI**:
   The AI helped create a single-page HTML file with CSS glassmorphism, response-time trackers, and loading indicators, displaying the Base64 cursor directly in the dashboard to make the technical design visual.
