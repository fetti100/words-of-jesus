/**
 * POST /api/ask
 *
 * Body: { question: string }
 * Response (SSE stream): text/event-stream of Claude's answer
 *
 * Pipeline:
 *   1. Embed the user question (OpenAI text-embedding-3-small)
 *   2. Cosine-similarity search over data/embeddings.json → top 15 verses
 *   3. Send those verses + system prompt + question to Claude Haiku 3.5
 *   4. Stream response back to the client
 */

import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./_prompt.js";

// Optional proxy dispatcher for local dev inside the Perplexity sandbox.
// Vercel production doesn't set HTTPS_PROXY, so this is a no-op there.
const USING_PROXY =
  !!process.env.HTTPS_PROXY &&
  (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY);

if (USING_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
}

// When the proxy is injecting auth, strip the SDK's own Authorization / x-api-key
// headers so the proxy's real key is used.
function proxyFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.delete("authorization");
  headers.delete("x-api-key");
  return fetch(url, { ...init, headers });
}

const TOP_K = 15;
const EMBED_MODEL = "text-embedding-3-small";
const CLAUDE_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;

// Simple in-memory cache — Vercel serverless will keep this warm between requests
// on the same container. Cold starts read the ~13 MB binary + tiny JSON metadata.
let cached = null;

async function loadEmbeddings() {
  if (cached) return cached;
  const dataDir = path.join(process.cwd(), "data");
  const [metaRaw, vecsBuf] = await Promise.all([
    fs.readFile(path.join(dataDir, "verses.json"), "utf-8"),
    fs.readFile(path.join(dataDir, "vectors.bin")),
  ]);
  const meta = JSON.parse(metaRaw);
  // Wrap the Node Buffer as a Float32Array (zero-copy view)
  const vectors = new Float32Array(
    vecsBuf.buffer,
    vecsBuf.byteOffset,
    vecsBuf.byteLength / 4
  );
  cached = {
    dimensions: meta.dimensions,
    count: meta.count,
    verses: meta.verses,
    vectors,
  };
  return cached;
}

async function retrieveTopVerses(question, data, k = TOP_K) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "proxied",
    fetch: USING_PROXY ? proxyFetch : undefined,
  });
  const resp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: question,
  });
  const qVec = resp.data[0].embedding;

  // Score every verse — read directly from the packed Float32Array
  const { dimensions: d, count: n, verses, vectors } = data;
  const scored = new Array(n);

  // Precompute question vector magnitude
  let qMag = 0;
  for (let j = 0; j < d; j++) qMag += qVec[j] * qVec[j];
  qMag = Math.sqrt(qMag);

  for (let i = 0; i < n; i++) {
    let dot = 0;
    let vMag = 0;
    const off = i * d;
    for (let j = 0; j < d; j++) {
      const a = qVec[j];
      const b = vectors[off + j];
      dot += a * b;
      vMag += b * b;
    }
    scored[i] = { ...verses[i], score: dot / (qMag * Math.sqrt(vMag)) };
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function buildContextBlock(verses) {
  const lines = verses.map(
    (v, i) => `[${i + 1}] ${v.reference}\n${v.text}`
  );
  return `CONTEXT — top ${verses.length} verses most relevant to the user's question:\n\n${lines.join("\n\n")}`;
}

export default async function handler(req, res) {
  // CORS for local dev + pplx.app preview
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, firstAnswer } = req.body || {};
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({ error: "Missing 'question' in request body" });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: "Question too long (max 500 chars)" });
  }
  // Default to true when the field is omitted — keeps the disclaimer for older clients.
  const isFirst = firstAnswer !== false;

  if (!USING_PROXY && (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)) {
    return res.status(500).json({
      error: "Server misconfigured: missing API keys",
    });
  }

  try {
    // 1. Retrieve top verses
    const embeddings = await loadEmbeddings();
    const topVerses = await retrieveTopVerses(question, embeddings, TOP_K);

    // 2. Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Send the retrieved verses first so the UI can show them
    res.write(
      `event: verses\ndata: ${JSON.stringify(
        topVerses.map(({ reference, text, book, chapter, verse, score }) => ({
          reference,
          text,
          book,
          chapter,
          verse,
          score: Math.round(score * 1000) / 1000,
        }))
      )}\n\n`
    );

    // 3. Stream Claude's answer
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "proxied",
      fetch: USING_PROXY ? proxyFetch : undefined,
    });
    const contextBlock = buildContextBlock(topVerses);

    // The system prompt describes how to handle the "written by human hands"
    // disclaimer on the first answer. On follow-ups, tell the model to skip it —
    // the user has already read it once in this conversation.
    const systemPrompt = isFirst
      ? SYSTEM_PROMPT
      : SYSTEM_PROMPT + `\n\n# CONVERSATION CONTINUATION\n\nThis is a FOLLOW-UP question in an ongoing conversation. The user already saw the "the men who wrote and compiled the Bible were only human" note in the very first answer of this conversation. **Do NOT repeat that disclaimer.** If the topic is one I didn't directly address, simply say so and offer the closest thematic quote — without re-explaining that the Bible was written by humans. Say it once per conversation, not once per answer.`;

    const stream = await anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `${contextBlock}\n\n---\n\nUser question: ${question}`,
        },
      ],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`event: token\ndata: ${JSON.stringify(event.delta.text)}\n\n`);
      }
    }

    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  } catch (err) {
    console.error("Ask endpoint error:", err);
    // If SSE already started, send an error event; otherwise send JSON
    if (res.headersSent) {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          message: err.message || "Unknown error",
        })}\n\n`
      );
      res.end();
    } else {
      res.status(500).json({ error: err.message || "Unknown error" });
    }
  }
}
