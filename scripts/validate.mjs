import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schema");
const seedDir = join(root, "seed");

// Заглушка, которую генераторы сидов ставят вместо значения, которое не смогли определить.
const REVIEW_PLACEHOLDER = "REVIEW_REQUIRED";

// One entry per register seed category. `dir: true` categories accept any number of
// *.json files contributed by different sources (see admin's SeedFileLoader.ReadDirectoryAsync);
// `dir: false` categories are single files written by exactly one source.
const categories = [
  { schema: "assets.schema.json", target: "assets.json", dir: false },
  { schema: "securities.schema.json", target: "securities", dir: true },
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
    // Заглушка генератора уже отмечена отдельной ошибкой ниже — не дублируем её как битую ссылку.
    if (key === REVIEW_PLACEHOLDER) return;
    if (!keys.has(key)) fail(`${file}: ${where}: unknown ${what} ${key}`);
  };

  // Борд входит в ключ справочного инструмента, пустой борд — тоже значение (data-model §3.1).
  const refKey = (r) => `${r.venue}/${r.board ?? ""}/${r.code}`;

  const venueItems = rows("venues", "venues");
  const boardItems = venueItems.flatMap(({ file, row }) =>
    (row.boards ?? []).map((board) => ({ file, row: { key: `${row.mic}/${board.code}`, id: board.id } })),
  );
  const securityItems = rows("securities", "securities");
  const referenceItems = rows("reference-instruments", "instruments");
  const futuresItems = rows("futures-products", "products");
  const optionsItems = rows("options-products", "products");

  const assetItems = rows("assets.json", "assets");

  // id сквозной по всем данным: один uuid не может принадлежать двум записям, даже разного вида.
  // Сравнение без учёта регистра — схема допускает hex в обоих регистрах.
  const ids = new Map();
  const entities = [
    [venueItems, "venue", (v) => v.mic],
    [boardItems, "board", (b) => b.key],
    [assetItems, "asset", (a) => a.symbol],
    [securityItems, "security", (s) => s.key],
    [referenceItems, "reference instrument", refKey],
    [futuresItems, "futures product", (p) => `${p.venue}/${p.code}`],
    [optionsItems, "options product", (p) => `${p.venue}/${p.code}`],
  ];
  for (const [items, what, keyOf] of entities) {
    for (const { file, row } of items) {
      const id = row.id.toLowerCase();
      const owner = `${what} ${keyOf(row)} (${file})`;
      if (ids.has(id)) {
        fail(`${file}: duplicate id ${row.id} on ${owner}, already used by ${ids.get(id)}`);
      } else {
        ids.set(id, owner);
      }
    }
  }

  // Генератор ставит REVIEW_REQUIRED, когда не смог определить значение сам; такая строка
  // не заливается провижном, поэтому в сиде её быть не должно — значение нужно заполнить руками.
  for (const [items, what, keyOf] of entities) {
    for (const { file, row } of items) {
      if (JSON.stringify(row).includes(REVIEW_PLACEHOLDER)) {
        fail(`${file}: ${what} ${keyOf(row)}: unresolved ${REVIEW_PLACEHOLDER}`);
      }
    }
  }

  const venues = index(venueItems, (v) => v.mic, "venue");
  const boards = index(boardItems, (b) => b.key, "board");
  const assets = index(assetItems, (a) => a.symbol, "asset");
  index(securityItems, (s) => s.key, "security");
  // Продукты ссылаются на бумагу по ISIN.
  const securities = index(securityItems, (s) => s.isin, "isin");
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
    if (p.board) need(boards, `${p.venue}/${p.board}`, file, where, "board");
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