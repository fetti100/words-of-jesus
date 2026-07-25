#!/usr/bin/env node
/**
 * pack-embeddings.js
 *
 * Takes data/embeddings.json (58 MB, one JSON array of 2,055 embedding objects
 * with 1536-dim float64 arrays each) and produces:
 *
 *   data/verses.json   — the metadata (reference, text, book, chapter, verse)
 *                        without the embedding arrays. Small, ~500 KB.
 *
 *   data/vectors.bin   — packed Float32Array (2055 × 1536 × 4 bytes = 12.6 MB)
 *                        in verse-order matching verses.json.
 *
 * Runtime loading is ~10× faster than parsing the giant JSON, and Vercel cold
 * starts stay under 200 ms.
 */

import fs from "node:fs/promises";
import path from "node:path";

const IN = path.join(process.cwd(), "data", "embeddings.json");
const OUT_META = path.join(process.cwd(), "data", "verses.json");
const OUT_VECS = path.join(process.cwd(), "data", "vectors.bin");

console.log(`Reading ${IN}...`);
const raw = await fs.readFile(IN, "utf-8");
const parsed = JSON.parse(raw);
const verses = parsed.verses;
const dim = parsed.dimensions;
const count = verses.length;

console.log(`Packing ${count} verses × ${dim} dims...`);

const meta = verses.map(({ embedding, ...rest }) => rest);
const buf = new Float32Array(count * dim);
for (let i = 0; i < count; i++) {
  const emb = verses[i].embedding;
  for (let j = 0; j < dim; j++) {
    buf[i * dim + j] = emb[j];
  }
}

await fs.writeFile(
  OUT_META,
  JSON.stringify({ model: parsed.model, dimensions: dim, count, verses: meta })
);
await fs.writeFile(OUT_VECS, Buffer.from(buf.buffer));

const metaSize = (await fs.stat(OUT_META)).size;
const vecsSize = (await fs.stat(OUT_VECS)).size;
console.log(`Wrote ${OUT_META} (${(metaSize / 1024).toFixed(0)} KB)`);
console.log(`Wrote ${OUT_VECS} (${(vecsSize / 1024 / 1024).toFixed(1)} MB)`);
