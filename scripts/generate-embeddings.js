#!/usr/bin/env node
/**
 * generate-embeddings.js
 *
 * One-time script: reads public/quotes.json, generates a 1536-dim embedding
 * for every verse using OpenAI text-embedding-3-small, and writes the result
 * to data/embeddings.json.
 *
 * Cost: ~$0.02 total for all 2,055 verses.
 * Run: npm run embed
 */

import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

// When running in the Perplexity sandbox with api_credentials=['custom-cred:api.openai.com'],
// the auth token is injected by an HTTPS_PROXY. Node's built-in fetch (undici) does not
// respect HTTPS_PROXY unless we configure a global dispatcher. This block is a no-op
// outside the sandbox (no HTTPS_PROXY set).
if (process.env.HTTPS_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
}

const QUOTES_PATH = path.join(process.cwd(), "public", "quotes.json");
const OUTPUT_PATH = path.join(process.cwd(), "data", "embeddings.json");
const MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100; // OpenAI accepts up to 2048 inputs per request; 100 is safe

// Real key when running locally with .env, or a placeholder when the proxy is injecting auth.
// When the proxy is active, we override fetch to strip the Authorization header the SDK sets,
// so the proxy's injected auth is used instead.
const usingProxy = !!process.env.HTTPS_PROXY && !process.env.OPENAI_API_KEY;
const apiKey = process.env.OPENAI_API_KEY || "proxied";

const customFetch = usingProxy
  ? (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.delete("authorization");
      return fetch(url, { ...init, headers });
    }
  : undefined;

const openai = new OpenAI({ apiKey, fetch: customFetch });

async function main() {
  console.log(`Reading ${QUOTES_PATH}...`);
  const raw = await fs.readFile(QUOTES_PATH, "utf-8");
  const quotesData = JSON.parse(raw);
  const verses = quotesData.quotes || [];

  if (verses.length === 0) {
    console.error("ERROR: no verses found in quotes.json. Expected 'quotes' array.");
    process.exit(1);
  }

  console.log(`Found ${verses.length} verses. Embedding with ${MODEL}...`);

  const embeddings = [];
  const startedAt = Date.now();

  for (let i = 0; i < verses.length; i += BATCH_SIZE) {
    const batch = verses.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((v) => {
      // Include the reference in the embedded text so retrieval benefits from book/context signal
      const ref = `${v.b} ${v.c}:${v.v}`;
      return `${ref} — ${v.t}`;
    });

    process.stdout.write(`  [${i + 1}–${Math.min(i + BATCH_SIZE, verses.length)}/${verses.length}] `);

    const resp = await openai.embeddings.create({
      model: MODEL,
      input: inputs,
    });

    resp.data.forEach((item, j) => {
      const v = batch[j];
      embeddings.push({
        idx: i + j,
        book: v.b,
        chapter: v.c,
        verse: v.v,
        reference: `${v.b} ${v.c}:${v.v}`,
        text: v.t,
        embedding: item.embedding,
      });
    });

    console.log(`ok (${resp.usage.total_tokens} tokens)`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nEmbedded ${embeddings.length} verses in ${elapsed}s.`);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const output = {
    model: MODEL,
    dimensions: embeddings[0].embedding.length,
    count: embeddings.length,
    generatedAt: new Date().toISOString(),
    verses: embeddings,
  };
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output));

  const sizeMB = ((await fs.stat(OUTPUT_PATH)).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${OUTPUT_PATH} (${sizeMB} MB).`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
