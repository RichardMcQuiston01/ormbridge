// Loads Zod modules with the real library and prints what Zod itself reports about every exported object
// schema, as JSON on stdout: the keys of `schema.shape` in order and, for each property, `isOptional()`,
// `isNullable()`, whether a default is set, and the schema underneath the wrappers (optional, nullable,
// default, catch, readonly, brand, lazy, transform, pipe) described through each version's own definition
// (`_def.typeName` and `_def.checks` in Zod 3, `_zod.def` and `_zod.bag` in Zod 4).
//
// Used by test/zod-parser-verify.test.ts, which compares this with what the ormbridge Zod reader read.
// Usage (run with tsx, from a directory whose node_modules has zod and, for 3, the alias zod3):
//   tsx inspect-zod.mjs <3|4> <module.ts>...
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const major = Number(process.argv[2]);
const files = process.argv.slice(3);
if (major !== 3 && major !== 4) {
  throw new Error('The first argument must be the Zod major version, 3 or 4.');
}

const definitionOf = (schema) => (major === 3 ? schema._def : schema._zod.def);
const typeOf = (schema) =>
  major === 3 ? schema._def.typeName : schema._zod.def.type;

const V3_KINDS = {
  ZodString: 'string',
  ZodNumber: 'number',
  ZodBigInt: 'bigint',
  ZodBoolean: 'boolean',
  ZodDate: 'date',
  ZodEnum: 'enum',
  ZodNativeEnum: 'enum',
  ZodLiteral: 'literal',
  ZodArray: 'array',
  ZodObject: 'object',
  ZodRecord: 'record',
  ZodMap: 'map',
  ZodAny: 'any',
  ZodUnknown: 'unknown',
  ZodUnion: 'union',
  ZodTuple: 'tuple',
  ZodDiscriminatedUnion: 'union',
  ZodIntersection: 'intersection',
  ZodNull: 'null',
  ZodUndefined: 'undefined',
};

/** One step through a wrapper, or undefined when the schema is not a wrapper. */
function unwrapOnce(schema) {
  const type = typeOf(schema);
  const definition = definitionOf(schema);
  if (major === 3) {
    switch (type) {
      case 'ZodOptional':
      case 'ZodNullable':
        return { schema: definition.innerType };
      case 'ZodDefault':
      case 'ZodCatch':
        return { schema: definition.innerType, defaulted: true };
      case 'ZodReadonly':
        return { schema: definition.innerType };
      case 'ZodBranded':
        return { schema: definition.type };
      case 'ZodEffects':
        return { schema: definition.schema, piped: true };
      case 'ZodPipeline':
        return { schema: definition.in, piped: true };
      case 'ZodLazy':
        return { schema: definition.getter() };
      default:
        return undefined;
    }
  }
  switch (type) {
    case 'optional':
    case 'nullable':
    case 'nonoptional':
    case 'readonly':
      return { schema: definition.innerType };
    case 'default':
    case 'prefault':
    case 'catch':
      return { schema: definition.innerType, defaulted: true };
    case 'pipe':
      return { schema: definition.in, piped: true };
    case 'lazy':
      return { schema: definition.getter() };
    default:
      return undefined;
  }
}

function strip(schema) {
  let current = schema;
  let defaulted = false;
  let piped = false;
  for (let depth = 0; depth < 20; depth += 1) {
    const step = unwrapOnce(current);
    if (step === undefined) {
      break;
    }
    current = step.schema;
    defaulted = defaulted || step.defaulted === true;
    piped = piped || step.piped === true;
  }
  return { leaf: current, defaulted, piped };
}

function stringFacts(leaf) {
  if (major === 3) {
    const checks = leaf._def.checks;
    const formats = checks
      .map((check) => check.kind)
      .filter(
        (kind) =>
          ![
            'min',
            'max',
            'length',
            'regex',
            'trim',
            'toLowerCase',
            'toUpperCase',
            'includes',
            'startsWith',
            'endsWith',
          ].includes(kind)
      );
    return {
      formats,
      // z.string().length(n) is a separate check in Zod 3 (Zod 4 folds it into maxLength).
      maxLength:
        leaf.maxLength ??
        checks.find((check) => check.kind === 'length')?.value ??
        null,
      patterns: checks
        .filter((check) => check.kind === 'regex')
        .map((check) => check.regex.source),
    };
  }
  const checks = leaf._zod.def.checks ?? [];
  const patterns = checks
    .map((check) => check._zod.def)
    .filter((def) => def.check === 'string_format' && def.format === 'regex')
    .map((def) => def.pattern.source);
  return {
    formats: leaf.format && leaf.format !== 'regex' ? [leaf.format] : [],
    maxLength: leaf.maxLength,
    patterns,
  };
}

function describeLeaf(leaf, exportsByInstance, depth) {
  const kind =
    major === 3 ? (V3_KINDS[typeOf(leaf)] ?? typeOf(leaf)) : typeOf(leaf);
  const facts = { kind, coerce: definitionOf(leaf).coerce === true };
  switch (kind) {
    case 'string':
      Object.assign(facts, stringFacts(leaf));
      break;
    case 'number':
      facts.int = leaf.isInt;
      break;
    case 'enum': {
      const entries =
        major === 3
          ? Array.isArray(leaf._def.values)
            ? Object.fromEntries(
                leaf._def.values.map((value) => [value, value])
              )
            : leaf._def.values
          : leaf._zod.def.entries;
      facts.entries = Object.fromEntries(
        Object.entries(entries).filter(([, value]) => typeof value === 'string')
      );
      facts.numeric = Object.values(entries).some(
        (value) => typeof value === 'number'
      );
      break;
    }
    case 'literal':
      facts.value = major === 3 ? leaf._def.value : leaf._zod.def.values[0];
      break;
    case 'array':
    case 'set':
      facts.element = describeProperty(
        leaf.element,
        exportsByInstance,
        depth + 1
      );
      break;
    case 'union':
      facts.options = (leaf.options ?? []).map((option) =>
        describeProperty(option, exportsByInstance, depth + 1)
      );
      break;
    case 'object':
      facts.objectRef = exportsByInstance.get(leaf) ?? null;
      break;
    default:
      break;
  }
  return facts;
}

function describeProperty(schema, exportsByInstance, depth) {
  if (depth > 3) {
    // z.json() is a recursive union: stop descending.
    return {
      optional: false,
      nullable: false,
      hasDefault: false,
      piped: false,
      leaf: { kind: 'deep' },
    };
  }
  const { leaf, defaulted, piped } = strip(schema);
  return {
    optional: schema.isOptional(),
    nullable: schema.isNullable(),
    hasDefault: defaulted,
    piped,
    leaf: describeLeaf(leaf, exportsByInstance, depth),
  };
}

const result = {};
for (const file of files) {
  const module = await import(pathToFileURL(resolve(file)).href);
  const objects = Object.entries(module).filter(
    ([, value]) =>
      value !== null &&
      typeof value === 'object' &&
      typeof value.parse === 'function' &&
      value.shape !== undefined &&
      typeof value.shape === 'object'
  );
  const exportsByInstance = new Map(
    objects.map(([name, value]) => [value, name])
  );
  const models = {};
  for (const [name, schema] of objects) {
    const properties = [];
    for (const [key, property] of Object.entries(schema.shape)) {
      properties.push({
        key,
        ...describeProperty(property, exportsByInstance, 0),
      });
    }
    models[name] = properties;
  }
  result[file] = models;
}
process.stdout.write(JSON.stringify(result));
