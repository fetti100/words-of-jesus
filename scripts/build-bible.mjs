/**
 * Fetches the World English Bible (WEB) for the 6 books that contain
 * verbatim words of Jesus (Matthew, Mark, Luke, John, Acts, Revelation)
 * from TehShrike/world-english-bible, and packs each into a compact
 * JSON file grouped by chapter.
 *
 * Output shape (per book):
 *   {
 *     book: "Matthew",
 *     chapters: {
 *       "1": [{ v: 1, t: "The book of the genealogy..." }, ...],
 *       "2": [{ v: 1, t: "..." }, ...],
 *       ...
 *     }
 *   }
 *
 * Verses are joined across paragraph splits (the source sometimes splits
 * one verse across multiple entries when a paragraph break falls mid-verse).
 *
 * Written to: public/bible/{book}.json
 */

import fs from "node:fs/promises";
import path from "node:path";

const BOOKS = [
  { slug: "matthew", name: "Matthew" },
  { slug: "mark", name: "Mark" },
  { slug: "luke", name: "Luke" },
  { slug: "john", name: "John" },
  { slug: "acts", name: "Acts" },
  { slug: "revelation", name: "Revelation" },
];

const OUT_DIR = path.resolve(process.cwd(), "public/bible");

async function fetchBook(slug) {
  const url = `https://cdn.jsdelivr.net/gh/TehShrike/world-english-bible@master/json/${slug}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed for ${slug}: ${res.status}`);
  return res.json();
}

/**
 * Collapse the paragraph-based source into { chapter: [verse] } form.
 * A verse's text is the concatenation of every `paragraph text` / `line text`
 * entry with that (chapter, verse) pair.
 */
function packBook(entries) {
  /** @type {Map<number, Map<number, string[]>>} */
  const chapters = new Map();
  for (const entry of entries) {
    const isText =
      entry.type === "paragraph text" || entry.type === "line text";
    if (!isText) continue;
    const ch = entry.chapterNumber;
    const vs = entry.verseNumber;
    if (typeof ch !== "number" || typeof vs !== "number") continue;
    if (!chapters.has(ch)) chapters.set(ch, new Map());
    const chapter = chapters.get(ch);
    if (!chapter.has(vs)) chapter.set(vs, []);
    chapter.get(vs).push(entry.value || "");
  }

  // Materialize into ordered, minified structure
  /** @type {Record<string, {v:number,t:string}[]>} */
  const out = {};
  const chapterKeys = [...chapters.keys()].sort((a, b) => a - b);
  for (const ch of chapterKeys) {
    const verses = chapters.get(ch);
    const verseKeys = [...verses.keys()].sort((a, b) => a - b);
    out[String(ch)] = verseKeys.map((v) => ({
      v,
      t: verses
        .get(v)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    }));
  }
  return out;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const index = [];
  for (const { slug, name } of BOOKS) {
    console.log(`Fetching ${name}…`);
    const raw = await fetchBook(slug);
    const chapters = packBook(raw);
    const chapterCount = Object.keys(chapters).length;
    const verseCount = Object.values(chapters).reduce(
      (n, verses) => n + verses.length,
      0
    );
    const payload = { book: name, chapters };
    const outPath = path.join(OUT_DIR, `${slug}.json`);
    await fs.writeFile(outPath, JSON.stringify(payload));
    const bytes = (await fs.stat(outPath)).size;
    console.log(
      `  ${name}: ${chapterCount} chapters, ${verseCount} verses, ${(bytes / 1024).toFixed(1)} KB`
    );
    index.push({ slug, name, chapters: chapterCount, verses: verseCount });
  }
  await fs.writeFile(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify({ translation: "WEB", books: index }, null, 2)
  );
  console.log("\nDone. Wrote", OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
