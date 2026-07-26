/**
 * Fetches the full 66-book World English Bible (WEB) from
 * TehShrike/world-english-bible and packs each book into a compact JSON
 * file grouped by chapter.
 *
 * Output shape (per book):
 *   {
 *     book: "Matthew",
 *     testament: "NT",
 *     order: 40,
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
 * Written to: public/bible/{slug}.json
 */

import fs from "node:fs/promises";
import path from "node:path";

// Canonical order. `slug` matches TehShrike's file name; `key` is the URL slug
// we use in-app (kebab-case for multi-word books); `name` is the display name.
const BOOKS = [
  // ------------------------------- Old Testament -------------------------------
  { slug: "genesis", key: "genesis", name: "Genesis", testament: "OT" },
  { slug: "exodus", key: "exodus", name: "Exodus", testament: "OT" },
  { slug: "leviticus", key: "leviticus", name: "Leviticus", testament: "OT" },
  { slug: "numbers", key: "numbers", name: "Numbers", testament: "OT" },
  { slug: "deuteronomy", key: "deuteronomy", name: "Deuteronomy", testament: "OT" },
  { slug: "joshua", key: "joshua", name: "Joshua", testament: "OT" },
  { slug: "judges", key: "judges", name: "Judges", testament: "OT" },
  { slug: "ruth", key: "ruth", name: "Ruth", testament: "OT" },
  { slug: "1samuel", key: "1-samuel", name: "1 Samuel", testament: "OT" },
  { slug: "2samuel", key: "2-samuel", name: "2 Samuel", testament: "OT" },
  { slug: "1kings", key: "1-kings", name: "1 Kings", testament: "OT" },
  { slug: "2kings", key: "2-kings", name: "2 Kings", testament: "OT" },
  { slug: "1chronicles", key: "1-chronicles", name: "1 Chronicles", testament: "OT" },
  { slug: "2chronicles", key: "2-chronicles", name: "2 Chronicles", testament: "OT" },
  { slug: "ezra", key: "ezra", name: "Ezra", testament: "OT" },
  { slug: "nehemiah", key: "nehemiah", name: "Nehemiah", testament: "OT" },
  { slug: "esther", key: "esther", name: "Esther", testament: "OT" },
  { slug: "job", key: "job", name: "Job", testament: "OT" },
  { slug: "psalms", key: "psalms", name: "Psalms", testament: "OT" },
  { slug: "proverbs", key: "proverbs", name: "Proverbs", testament: "OT" },
  { slug: "ecclesiastes", key: "ecclesiastes", name: "Ecclesiastes", testament: "OT" },
  { slug: "songofsolomon", key: "song-of-solomon", name: "Song of Solomon", testament: "OT" },
  { slug: "isaiah", key: "isaiah", name: "Isaiah", testament: "OT" },
  { slug: "jeremiah", key: "jeremiah", name: "Jeremiah", testament: "OT" },
  { slug: "lamentations", key: "lamentations", name: "Lamentations", testament: "OT" },
  { slug: "ezekiel", key: "ezekiel", name: "Ezekiel", testament: "OT" },
  { slug: "daniel", key: "daniel", name: "Daniel", testament: "OT" },
  { slug: "hosea", key: "hosea", name: "Hosea", testament: "OT" },
  { slug: "joel", key: "joel", name: "Joel", testament: "OT" },
  { slug: "amos", key: "amos", name: "Amos", testament: "OT" },
  { slug: "obadiah", key: "obadiah", name: "Obadiah", testament: "OT" },
  { slug: "jonah", key: "jonah", name: "Jonah", testament: "OT" },
  { slug: "micah", key: "micah", name: "Micah", testament: "OT" },
  { slug: "nahum", key: "nahum", name: "Nahum", testament: "OT" },
  { slug: "habakkuk", key: "habakkuk", name: "Habakkuk", testament: "OT" },
  { slug: "zephaniah", key: "zephaniah", name: "Zephaniah", testament: "OT" },
  { slug: "haggai", key: "haggai", name: "Haggai", testament: "OT" },
  { slug: "zechariah", key: "zechariah", name: "Zechariah", testament: "OT" },
  { slug: "malachi", key: "malachi", name: "Malachi", testament: "OT" },
  // ------------------------------- New Testament -------------------------------
  { slug: "matthew", key: "matthew", name: "Matthew", testament: "NT" },
  { slug: "mark", key: "mark", name: "Mark", testament: "NT" },
  { slug: "luke", key: "luke", name: "Luke", testament: "NT" },
  { slug: "john", key: "john", name: "John", testament: "NT" },
  { slug: "acts", key: "acts", name: "Acts", testament: "NT" },
  { slug: "romans", key: "romans", name: "Romans", testament: "NT" },
  { slug: "1corinthians", key: "1-corinthians", name: "1 Corinthians", testament: "NT" },
  { slug: "2corinthians", key: "2-corinthians", name: "2 Corinthians", testament: "NT" },
  { slug: "galatians", key: "galatians", name: "Galatians", testament: "NT" },
  { slug: "ephesians", key: "ephesians", name: "Ephesians", testament: "NT" },
  { slug: "philippians", key: "philippians", name: "Philippians", testament: "NT" },
  { slug: "colossians", key: "colossians", name: "Colossians", testament: "NT" },
  { slug: "1thessalonians", key: "1-thessalonians", name: "1 Thessalonians", testament: "NT" },
  { slug: "2thessalonians", key: "2-thessalonians", name: "2 Thessalonians", testament: "NT" },
  { slug: "1timothy", key: "1-timothy", name: "1 Timothy", testament: "NT" },
  { slug: "2timothy", key: "2-timothy", name: "2 Timothy", testament: "NT" },
  { slug: "titus", key: "titus", name: "Titus", testament: "NT" },
  { slug: "philemon", key: "philemon", name: "Philemon", testament: "NT" },
  { slug: "hebrews", key: "hebrews", name: "Hebrews", testament: "NT" },
  { slug: "james", key: "james", name: "James", testament: "NT" },
  { slug: "1peter", key: "1-peter", name: "1 Peter", testament: "NT" },
  { slug: "2peter", key: "2-peter", name: "2 Peter", testament: "NT" },
  { slug: "1john", key: "1-john", name: "1 John", testament: "NT" },
  { slug: "2john", key: "2-john", name: "2 John", testament: "NT" },
  { slug: "3john", key: "3-john", name: "3 John", testament: "NT" },
  { slug: "jude", key: "jude", name: "Jude", testament: "NT" },
  { slug: "revelation", key: "revelation", name: "Revelation", testament: "NT" },
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
  let totalBytes = 0;
  for (let i = 0; i < BOOKS.length; i++) {
    const { slug, key, name, testament } = BOOKS[i];
    const order = i + 1;
    process.stdout.write(`  [${String(order).padStart(2)}/66] ${name.padEnd(18)} … `);
    const raw = await fetchBook(slug);
    const chapters = packBook(raw);
    const chapterCount = Object.keys(chapters).length;
    const verseCount = Object.values(chapters).reduce(
      (n, verses) => n + verses.length,
      0
    );
    const payload = { book: name, testament, order, chapters };
    // On disk we use the URL-friendly `key` (kebab-case for multi-word books).
    const outPath = path.join(OUT_DIR, `${key}.json`);
    await fs.writeFile(outPath, JSON.stringify(payload));
    const bytes = (await fs.stat(outPath)).size;
    totalBytes += bytes;
    console.log(
      `${chapterCount} ch, ${verseCount} v, ${(bytes / 1024).toFixed(1)} KB`
    );
    index.push({ key, name, testament, order, chapters: chapterCount, verses: verseCount });
  }
  await fs.writeFile(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify({ translation: "WEB", books: index }, null, 2)
  );
  console.log(`\nDone. Wrote 66 books + index.json to ${OUT_DIR}`);
  console.log(`Total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB (loaded per-book on demand).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
