#!/usr/bin/env node
/**
 * Local smoke test for /api/ask handler.
 *
 * Bypasses Vercel — imports the handler directly and simulates an HTTP request.
 * Requires both API keys to be available (either via .env or the sandbox proxy).
 *
 * Usage:  node scripts/test-ask.js "your question here"
 */

import handler from "../api/ask.js";

const question = process.argv.slice(2).join(" ") || "Did Jesus talk about abortion?";

// Minimal req/res mocks that satisfy the handler
const req = {
  method: "POST",
  body: { question },
};

const res = {
  headersSent: false,
  statusCode: 200,
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  write(chunk) {
    this.headersSent = true;
    process.stdout.write(chunk);
  },
  json(obj) {
    console.log("JSON response:", JSON.stringify(obj, null, 2));
  },
  end() {
    console.log("\n\n[stream ended, status=" + this.statusCode + "]");
  },
};

console.log(`\n=== Testing: "${question}" ===\n`);
await handler(req, res);
