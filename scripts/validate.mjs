import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schema");
const seedDir = join(root, "seed");

// One entry per register seed category. `dir: true` categories accept any number of
// *.json files contributed by different sources (see admin's SeedFileLoader.ReadDirectoryAsync);
// `dir: false` categories are single files written by exactly one source.
const categories = [
  { schema: "assets.schema.json", target: "assets.json", dir: false },
  { schema: "securities.schema.json", target: "securities.json", dir: false },
  { schema: "venues.schema.json", target: "venues", dir: true },
  { schema: "reference-instruments.schema.json", target: "reference-instruments", dir: true },
  { schema: "futures-products.schema.json", target: "futures-products", dir: true },
  { schema: "options-products.schema.json", target: "options-products", dir: true },
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

let hasError = false;
const loaded = Object.fromEntries(categories.map(({ target }) => [target, []]));

for (const { schema, target, dir } of categories) {
  const schemaPath = join(schemaDir, schema);
  const schemaJson = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = ajv.compile(schemaJson);

  const targetPath = join(seedDir, target);
  const files = dir
    ? readdirSync(targetPath)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => join(targetPath, f))
    : [targetPath];

  for (const file of files) {
    const relPath = relative(root, file);
    const data = JSON.parse(readFileSync(file, "utf8"));
    loaded[target].push({ file: relPath, data });

    if (typeof data.$schema !== "string") {
      console.error(`x ${relPath}: missing "$schema" field`);
      hasError = true;
    } else {
      const declaredPath = resolve(dirname(file), data.$schema);
      if (declaredPath !== resolve(schemaPath)) {
        console.error(
          `x ${relPath}: "$schema" is "${data.$schema}" (resolves to ${declaredPath}), ` +
            `expected it to resolve to ${schemaPath}`,
        );
        hasError = true;
      }
    }

    if (!validate(data)) {
      console.error(`x ${relPath}: failed validation against ${schema}`);
      for (const err of validate.errors ?? []) {
        console.error(`    ${err.instancePath || "/"} ${err.message}`);
      }
      hasError = true;
    } else {
      console.log(`  ${relPath}`);
    }
  }
}

if (!hasError) {
  checkReferences();
}

if (hasError) {
  console.error("\nValidation failed.");
  process.exit(1);
}

console.log("\nAll seed files are valid.");

// Уникальность ключей и существование ссылок между файлами; ключи — по data-model §3.1, §5, §6.
// settlementFixing не проверяется: это нестрогая ссылка (data-model §8.9).
function checkReferences() {
  const fail = (message) => {
    console.error(`x ${message}`);
    hasError = true;
  };

  const rows = (target, prop) =>
    loaded[target].flatMap(({ file, data }) => data[prop].map((row) => ({ file, row })));

  const index = (items, keyOf, what) => {
    const seen = new Map();
    for (const { file, row } of items) {
      const key = keyOf(row);
      if (seen.has(key)) {
        fail(`${file}: duplicate ${what} ${key} (first in ${seen.get(key)})`);
      } else {
        seen.set(key, file);
      }
    }
    return seen;
  };

  const need = (keys, key, file, where, what) => {
    if (!keys.has(key)) fail(`${file}: ${where}: unknown ${what} ${key}`);
  };

  // Борд входит в ключ справочного инструмента, пустой борд — тоже значение (data-model §3.1).
  const refKey = (r) => `${r.venue}/${r.board ?? ""}/${r.code}`;

  const venueItems = rows("venues", "venues");
  const boardItems = venueItems.flatMap(({ file, row }) =>
    (row.boards ?? []).map((board) => ({ file, row: { key: `${row.mic}/${board.code}` } })),
  );
  const securityItems = rows("securities.json", "securities");
  const referenceItems = rows("reference-instruments", "instruments");
  const futuresItems = rows("futures-products", "products");
  const optionsItems = rows("options-products", "products");

  const venues = index(venueItems, (v) => v.mic, "venue");
  const boards = index(boardItems, (b) => b.key, "board");
  const assets = index(rows("assets.json", "assets"), (a) => a.symbol, "asset");
  // Продукты ссылаются на бумагу по key — полю сида, а не по ISIN.
  const securities = index(securityItems, (s) => s.key, "security");
  index(securityItems, (s) => s.isin, "isin");
  const references = index(referenceItems, refKey, "reference instrument");
  const futures = index(futuresItems, (p) => `${p.venue}/${p.code}`, "futures product");
  // Один код на площадке может быть у двух классов опционов: маржируемого и с премией (data-model §5.2).
  index(optionsItems, (p) => `${p.venue}/${p.code}/${p.exerciseStyle}/${p.premiumStyle}`, "options product");

  for (const { file, row: r } of referenceItems) {
    const where = `reference instrument ${r.code}`;
    need(venues, r.venue, file, where, "venue");
    // Борд должен быть заведён у той же площадки.
    if (r.board) need(boards, `${r.venue}/${r.board}`, file, where, "board");
    if (r.settlementAsset) need(assets, r.settlementAsset, file, where, "asset");
  }

  for (const { file, row: p } of [...futuresItems, ...optionsItems]) {
    const where = `product ${p.code}`;
    const u = p.underlying;
    need(venues, p.venue, file, where, "venue");
    need(assets, p.quoteAsset, file, where, "asset");
    if (u.asset) need(assets, u.asset, file, where, "asset");
    if (u.security) need(securities, u.security, file, where, "security");
    if (u.reference) need(references, refKey(u.reference), file, where, "reference instrument");
    if (u.futuresProduct) {
      need(futures, `${u.futuresProduct.venue}/${u.futuresProduct.code}`, file, where, "futures product");
    }
  }

  for (const { file, row: s } of securityItems) {
    if (!s.debt) continue;
    const where = `security ${s.key}`;
    // Все валюты, фиатные и крипто, заведены как активы.
    need(assets, s.debt.faceCurrency, file, where, "asset");
    if (s.debt.floatBenchmark) need(references, refKey(s.debt.floatBenchmark), file, where, "reference instrument");
  }
}