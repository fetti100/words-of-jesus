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

const TOP_K = 15;
const EMBED_MODEL = "text-embedding-3-small";
const CLAUDE_MODEL = "claude-3-5-haiku-latest";
const MAX_TOKENS = 1024;

// Simple in-memory cache — Vercel serverless will keep this warm between requests
// on the same container. Cold starts reload embeddings.json (~10 MB).
let cachedEmbeddings = null;

async function loadEmbeddings() {
  if (cachedEmbeddings) return cachedEmbeddings;
  const embPath = path.join(process.cwd(), "data", "embeddings.json");
  const raw = await fs.readFile(embPath, "utf-8");
  cachedEmbeddings = JSON.parse(raw);
  return cachedEmbeddings;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function retrieveTopVerses(question, embeddings, k = TOP_K) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: question,
  });
  const qVec = resp.data[0].embedding;

  // Score every verse
  const scored = embeddings.verses.map((v) => ({
    ...v,
    score: cosineSimilarity(qVec, v.embedding),
  }));
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

  const { question } = req.body || {};
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({ error: "Missing 'question' in request body" });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: "Question too long (max 500 chars)" });
  }

  if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
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
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const contextBlock = buildContextBlock(topVerses);

    const stream = await anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
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
