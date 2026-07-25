# The Words of Jesus

A minimalist site presenting the direct words of Jesus (2,055 verses, World English Bible, public domain), organized by theme, with an AI assistant grounded strictly in those verbatim quotes.

## Live sites

- Primary: [jesus.bio](https://jesus.bio)
- Alternate: [wordsofjesus.app](https://wordsofjesus.app)
- Preview build: [wordsofjesus.pplx.app](https://wordsofjesus.pplx.app)

## Architecture

- **`public/`** — Static site: HTML, CSS, JS, the quotes JSON
- **`api/ask.js`** — Vercel serverless function powering the "Ask him" feature (RAG over the 2,055 verses using OpenAI embeddings and Claude Haiku)
- **`data/embeddings.json`** — Precomputed embedding vectors for each verse (~10 MB, gitignored — regenerate via `npm run embed`)
- **`scripts/generate-embeddings.js`** — One-time script to embed every verse

## Ask feature guardrails

The system prompt enforces:

1. **Never invent quotes.** The model can only cite verses returned by the retrieval step.
2. **Always lead with a yes/no.** "Did Jesus speak directly to this?" is the first sentence of every answer.
3. **No refusals.** Hard questions (politics, sexuality, ICE, wealth) get engaged honestly. If Jesus didn't address a topic, the model says so plainly instead of dodging.
4. **No sermonizing.** Direct, factual, quiet. His words carry the weight.

## Local dev

```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY and OPENAI_API_KEY
npm run embed          # one-time, generates data/embeddings.json
npm run dev            # starts vercel dev on localhost:3000
```

## Content sources

- **Verses:** [World English Bible](https://ebible.org/web/) — public domain, Majority Text tradition (includes John 7:53–8:11, Mark 16:9–20, Luke 23:34 which some critical translations omit)
- **Extraction:** `/bible/` directory in the workspace contains the USFX XML source and extraction pipeline
