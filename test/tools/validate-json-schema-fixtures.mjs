// Checks JSON Schema and OpenAPI documents with the real Ajv validator.
//
// Usage: node validate-json-schema-fixtures.mjs <AJV_DIR> [--compile] <file>...
//
// AJV_DIR is a directory where `npm install ajv ajv-formats` has been run. Every file is checked
// against the meta-schema of its dialect (draft-07, 2019-09 or 2020-12; OpenAPI documents use the
// draft-07 rules plus `nullable`). With --compile all files are also added to one Ajv instance and
// every schema is compiled, which resolves each $ref (local pointers and $id-relative references
// between the files). Prints one JSON object: { files: [{ file, metaSchemaValid, errors }], compiled, errors }.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const ajvDir = args.shift();
const compile = args[0] === '--compile';
if (compile) {
  args.shift();
}
const files = args;
const require = createRequire(join(ajvDir, 'package.json'));
const Draft07 = require('ajv');
const Draft2019 = require('ajv/dist/2019');
const Draft2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

// Formats that OpenAPI and this package use but that ajv-formats does not define.
const EXTRA_FORMATS = ['decimal', 'int32', 'int64', 'float', 'double'];

function makeAjv(Class) {
  const ajv = new Class({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of EXTRA_FORMATS) {
    ajv.addFormat(format, true);
  }
  return ajv;
}

function dialectOf(schema) {
  const declared = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (declared.includes('2020-12')) {
    return Draft2020;
  }
  if (declared.includes('2019-09')) {
    return Draft2019;
  }
  return Draft07;
}

const result = { files: [], compiled: null, errors: [] };
const documents = files.map((file) => ({
  file,
  schema: JSON.parse(readFileSync(file, 'utf8')),
}));

for (const { file, schema } of documents) {
  const ajv = makeAjv(dialectOf(schema));
  const isOpenApi = typeof schema.openapi === 'string';
  let valid = true;
  let errors = [];
  if (isOpenApi) {
    // The OpenAPI document itself is not a JSON Schema: check every schema in components.schemas.
    for (const [name, component] of Object.entries(
      schema.components?.schemas ?? {}
    )) {
      if (!ajv.validateSchema(component)) {
        valid = false;
        errors.push(`${name}: ${ajv.errorsText(ajv.errors)}`);
      }
    }
  } else {
    valid = ajv.validateSchema(schema) === true;
    errors = valid ? [] : [ajv.errorsText(ajv.errors)];
  }
  result.files.push({ file, metaSchemaValid: valid, errors });
}

if (compile) {
  result.compiled = true;
  const byClass = new Map();
  for (const { schema } of documents) {
    const Class = dialectOf(schema);
    if (!byClass.has(Class)) {
      byClass.set(Class, makeAjv(Class));
    }
  }
  for (const { file, schema } of documents) {
    const ajv = byClass.get(dialectOf(schema));
    try {
      if (typeof schema.openapi === 'string') {
        ajv.addSchema(schema, file);
      } else {
        ajv.addSchema(schema, schema.$id ?? file);
      }
    } catch (thrown) {
      result.compiled = false;
      result.errors.push(`${file}: ${thrown.message}`);
    }
  }
  for (const { file, schema } of documents) {
    const ajv = byClass.get(dialectOf(schema));
    try {
      if (typeof schema.openapi === 'string') {
        for (const name of Object.keys(schema.components?.schemas ?? {})) {
          const validate = ajv.getSchema(`${file}#/components/schemas/${name}`);
          if (validate === undefined) {
            throw new Error(`could not compile components.schemas.${name}`);
          }
        }
      } else {
        ajv.getSchema(schema.$id ?? file);
        for (const name of Object.keys(
          schema.$defs ?? schema.definitions ?? {}
        )) {
          const key = schema.$defs ? '$defs' : 'definitions';
          const validate = ajv.getSchema(
            `${schema.$id ?? file}#/${key}/${name}`
          );
          if (validate === undefined) {
            throw new Error(`could not compile ${key}.${name}`);
          }
        }
      }
    } catch (thrown) {
      result.compiled = false;
      result.errors.push(`${file}: ${thrown.message}`);
    }
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
