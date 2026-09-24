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

if (hasError) {
  console.error("\nValidation failed.");
  process.exit(1);
}

console.log("\nAll seed files are valid.");
