import type { MultiFileEmitOutput } from '../formats.js';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { splitWords, toSnakeCase } from '../naming.js';
import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import type { NamingMode } from '../transforms.js';
import type { PrismaProvider } from './prisma.js';

/**
 * GORM emitter (Go structs with `gorm:"..."` tags). Writes one file per model
 * (`models/post.go`) and one per enum (`models/post_status.go`), so it returns
 * the multi-file form of the emit contract. Column and table names that match
 * GORM's naming conventions are left implicit; everything else is written out.
 */
export interface GormEmitOptions {
  /** Database provider; chooses column types such as `uuid` vs `char(36)` and the UUID default. */
  provider: PrismaProvider;
  /** "normalize" applies GORM's conventions (plural snake_case tables, timestamps) before writing. */
  naming: NamingMode;
  /** Go package name of the generated files (default `models`); also the output directory. */
  goPackage?: string;
}

export const DEFAULT_GO_PACKAGE: string = 'models';

const GO_PACKAGE_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INDENT: string = '\t';

const GO_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'break default func interface select case defer go map struct chan else ' +
    'goto package switch const fallthrough if range type continue for import ' +
    'return var'
  ).split(' ')
);

/** True when `value` can be used as a Go package name: an identifier that is not `_` or a keyword. */
export function isValidGoPackageName(value: string): boolean {
  return (
    GO_PACKAGE_PATTERN.test(value) && value !== '_' && !GO_KEYWORDS.has(value)
  );
}

const ON_DELETE_NAMES: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

/** Methods GORM looks for on a model; a field with the same name would not compile. */
const RESERVED_MEMBER_NAMES: readonly string[] = ['TableName', 'BeforeCreate'];

/** The columns `gorm.Model` adds, as Go field names. */
const GORM_MODEL_MEMBERS: readonly string[] = [
  'Model',
  'ID',
  'CreatedAt',
  'UpdatedAt',
  'DeletedAt',
];

/** Operating systems and architectures whose names in `name_<suffix>.go` make Go skip the file elsewhere. */
const GO_FILE_SUFFIXES: ReadonlySet<string> = new Set(
  (
    'test aix android darwin dragonfly freebsd hurd illumos ios js linux ' +
    'nacl netbsd openbsd plan9 solaris wasip1 windows zos 386 amd64 arm arm64 ' +
    'loong64 mips mipsle mips64 mips64le ppc64 ppc64le riscv64 s390x sparc64 wasm'
  ).split(' ')
);

type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'sqlserver';

/** Packages a generated file can import; each is added only when the file uses it. */
type GoImport = 'time' | 'uuid' | 'decimal' | 'datatypes' | 'gorm';

const IMPORT_PATHS: Readonly<Record<GoImport, string>> = {
  time: 'time',
  uuid: 'github.com/google/uuid',
  decimal: 'github.com/shopspring/decimal',
  datatypes: 'gorm.io/datatypes',
  gorm: 'gorm.io/gorm',
};

/** How a default value is written in a tag. */
type ValueKind =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'time'
  | 'uuid'
  | 'decimal'
  | 'json'
  | 'bytes'
  | 'duration'
  | 'enum'
  | 'other';

/** The Go type of a column and the tag entries that describe it. */
interface ScalarSpec {
  /** Go type without the pointer, e.g. `int32` or `time.Time`. */
  goType: string;
  /** `type:` and `size:` entries. */
  typeEntries: string[];
  kind: ValueKind;
  imports: GoImport[];
  /** True when the Go type holds nil itself (slices, JSON), so a nullable column needs no pointer. */
  nilable: boolean;
  /** True for date and date-time columns, where `autoCreateTime` and `autoUpdateTime` apply. */
  temporal: boolean;
  enumDefinition?: IrEnum;
}

/** One line of a struct: a column, a foreign key, an association or an embedded type. */
interface Member {
  /** Go field name; empty for an embedded type. */
  name: string;
  type: string;
  /** Entries of the `gorm:"..."` tag, in order. */
  entries: string[];
  role: 'column' | 'association';
}

interface UuidHook {
  member: string;
  /** `uuid.UUID` columns, string columns, or a nullable `*uuid.UUID`. */
  style: 'value' | 'pointer' | 'string';
  version7: boolean;
}

/** A to-one relation after its foreign key and belongs-to field were planned. */
interface OwnedRelation {
  relation: IrRelation;
  target: IrModel;
  foreignKey: Member;
  association: Member;
  /** Go name of the referenced field when it is not the primary key. */
  references?: string;
  constraint?: string;
}

interface StructPlan {
  model: IrModel;
  typeName: string;
  fileStem: string;
  embedsModel: boolean;
  members: Member[];
  names: Set<string>;
  imports: Set<GoImport>;
  /** IR field name to Go field name. */
  fieldNames: Map<string, string>;
  /** "f:<field>" and "r:<relation>" to the member that holds the column. */
  byKey: Map<string, Member>;
  owned: Map<string, OwnedRelation>;
  /** Names of the many-to-many relations this struct owns. */
  manyToMany: Set<string>;
  uuidHooks: UuidHook[];
  tableName?: string;
}

interface EmitContext {
  schema: IrSchema;
  options: GormEmitOptions;
  dialect: Dialect;
  warnings: string[];
  packageName: string;
  /** Package-level names: model types, enum types and enum constants. */
  typeNames: Set<string>;
  modelTypes: Map<string, string>;
  enumTypes: Map<string, string>;
  plans: Map<string, StructPlan>;
  /** Models a struct holds by value; used to avoid recursive struct types. */
  valueEdges: Map<string, Set<string>>;
}

export function emitGorm(
  schema: IrSchema,
  options: GormEmitOptions
): MultiFileEmitOutput {
  const prepared: IrSchema =
    options.naming === 'normalize' ? normalizeGormSchema(schema) : schema;
  const warnings: string[] = prismaOnlyWarnings(prepared);
  let packageName: string = DEFAULT_GO_PACKAGE;
  if (options.goPackage !== undefined) {
    if (isValidGoPackageName(options.goPackage)) {
      packageName = options.goPackage;
    } else {
      warnings.push(
        `The Go package name "${options.goPackage}" is not valid; "${DEFAULT_GO_PACKAGE}" was used instead.`
      );
    }
  }
  const context: EmitContext = {
    schema: prepared,
    options,
    dialect: dialectOf(options.provider),
    warnings,
    packageName,
    typeNames: new Set<string>(),
    modelTypes: new Map<string, string>(),
    enumTypes: new Map<string, string>(),
    plans: new Map<string, StructPlan>(),
    valueEdges: new Map<string, Set<string>>(),
  };
  if (options.provider === 'mongodb') {
    warnings.push(
      'Provider "mongodb": GORM is relational (it has no MongoDB driver); relational models were written.'
    );
  }

  allocateTypeNames(context);
  for (const model of prepared.models) {
    planStruct(context, model);
  }
  for (const model of prepared.models) {
    planOwnedRelations(context, model);
  }
  for (const model of prepared.models) {
    planInverseSides(context, model);
  }
  for (const model of prepared.models) {
    planIndexes(context, model);
  }
  for (const plan of context.plans.values()) {
    if (gormTableName(plan.typeName) !== plan.model.tableName) {
      plan.tableName = plan.model.tableName;
    }
  }
  removeHandledWarnings(context);

  const files: Record<string, string> = {};
  const fileStems: Set<string> = new Set<string>();
  for (const enumDefinition of prepared.enums) {
    const typeName: string = context.enumTypes.get(enumDefinition.name) ?? '';
    const stem: string = uniqueFileStem(typeName, fileStems);
    files[`${packageName}/${stem}.go`] = renderEnum(
      context,
      enumDefinition,
      typeName
    );
  }
  for (const model of prepared.models) {
    const plan: StructPlan | undefined = context.plans.get(model.name);
    if (plan !== undefined) {
      plan.fileStem = uniqueFileStem(plan.typeName, fileStems);
      files[`${packageName}/${plan.fileStem}.go`] = renderStruct(context, plan);
    }
  }
  return { files, warnings };
}

// ---------------------------------------------------------------------------
// GORM naming conventions
// ---------------------------------------------------------------------------

/** The initialisms GORM's default naming strategy keeps together (`ID` becomes `id`, not `i_d`). */
const GORM_INITIALISMS: readonly string[] = [
  'API',
  'ASCII',
  'CPU',
  'CSS',
  'DNS',
  'EOF',
  'GUID',
  'HTML',
  'HTTP',
  'HTTPS',
  'ID',
  'IP',
  'JSON',
  'LHS',
  'QPS',
  'RAM',
  'RHS',
  'RPC',
  'SLA',
  'SMTP',
  'SSH',
  'TLS',
  'TTL',
  'UID',
  'UI',
  'UUID',
  'URI',
  'URL',
  'UTF8',
  'VM',
  'XML',
  'XSRF',
  'XSS',
];

/** Initialisms written in capitals in Go names (GORM's list plus a few the Go linters add). */
const GO_INITIALISMS: ReadonlySet<string> = new Set<string>([
  ...GORM_INITIALISMS,
  'ACL',
  'SQL',
  'TCP',
  'UDP',
  'XMPP',
]);

function isAsciiUpper(char: string | undefined): boolean {
  return char !== undefined && char >= 'A' && char <= 'Z';
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/** Go's `strings.Title` for an initialism that is all capitals: first letter up, the rest down. */
function titleCase(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

/**
 * Replaces the common initialisms the way GORM's `strings.NewReplacer` does:
 * left to right, the first initialism in list order that matches wins.
 */
function replaceInitialisms(name: string): string {
  let result: string = '';
  let position: number = 0;
  while (position < name.length) {
    const initialism: string | undefined = GORM_INITIALISMS.find(
      (candidate: string) => name.startsWith(candidate, position)
    );
    if (initialism === undefined) {
      result += name.charAt(position);
      position += 1;
    } else {
      result += titleCase(initialism);
      position += initialism.length;
    }
  }
  return result;
}

/**
 * The column name GORM derives from a Go field name (`schema.NamingStrategy.ColumnName`,
 * gorm v1.31): `PublicID` becomes `public_id`, `HTTPServer` becomes `http_server`.
 */
export function gormColumnName(goName: string): string {
  if (goName === '') {
    return '';
  }
  const value: string = replaceInitialisms(goName);
  let result: string = '';
  let lastCase: boolean = false;
  let currentCase: boolean = isAsciiUpper(value.charAt(0));
  for (let index: number = 0; index < value.length - 1; index += 1) {
    const char: string = value.charAt(index);
    const next: string = value.charAt(index + 1);
    const nextCase: boolean = isAsciiUpper(next);
    const nextNumber: boolean = isAsciiDigit(next);
    if (currentCase) {
      if (lastCase && (nextCase || nextNumber)) {
        result += char.toLowerCase();
      } else {
        if (index > 0 && value.charAt(index - 1) !== '_' && next !== '_') {
          result += '_';
        }
        result += char.toLowerCase();
      }
    } else {
      result += char;
    }
    lastCase = currentCase;
    currentCase = nextCase;
  }
  const last: string = value.charAt(value.length - 1);
  if (currentCase) {
    if (!lastCase && value.length > 1) {
      result += '_';
    }
    result += last.toLowerCase();
  } else {
    result += last;
  }
  return result;
}

type PluralRule = [RegExp, string];

const UNCOUNTABLE_WORDS: readonly string[] = [
  'equipment',
  'information',
  'rice',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'jeans',
  'police',
];

const IRREGULAR_PLURALS: readonly (readonly [string, string])[] = [
  ['person', 'people'],
  ['man', 'men'],
  ['child', 'children'],
  ['sex', 'sexes'],
  ['move', 'moves'],
  ['mombie', 'mombies'],
];

/** The regular rules of github.com/jinzhu/inflection; the last one that matches wins. */
const REGULAR_PLURALS: readonly (readonly [string, string])[] = [
  ['([a-z])$', '$1s'],
  ['s$', 's'],
  ['^(ax|test)is$', '$1es'],
  ['(octop|vir)us$', '$1i'],
  ['(octop|vir)i$', '$1i'],
  ['(alias|status)$', '$1es'],
  ['(bu)s$', '$1ses'],
  ['(buffal|tomat)o$', '$1oes'],
  ['([ti])um$', '$1a'],
  ['([ti])a$', '$1a'],
  ['sis$', 'ses'],
  ['(?:([^f])fe|([lr])f)$', '$1$2ves'],
  ['(hive)$', '$1s'],
  ['([^aeiouy]|qu)y$', '$1ies'],
  ['(x|ch|ss|sh)$', '$1es'],
  ['(matr|vert|ind)(?:ix|ex)$', '$1ices'],
  ['^(m|l)ouse$', '$1ice'],
  ['^(m|l)ice$', '$1ice'],
  ['^(ox)$', '$1en'],
  ['^(oxen)$', '$1'],
  ['(quiz)$', '$1zes'],
];

/** The rule list in the order github.com/jinzhu/inflection tries it. */
function buildPluralRules(): PluralRule[] {
  const rules: PluralRule[] = [];
  for (const word of UNCOUNTABLE_WORDS) {
    rules.push([new RegExp(`^(${word})$`, 'i'), '$1']);
  }
  for (const [singular, plural] of IRREGULAR_PLURALS) {
    rules.push(
      [new RegExp(`${singular.toUpperCase()}$`), plural.toUpperCase()],
      [new RegExp(`${titleCase(singular)}$`), titleCase(plural)],
      [new RegExp(`${singular}$`), plural]
    );
  }
  for (let index: number = REGULAR_PLURALS.length - 1; index >= 0; index -= 1) {
    const [find, replacement] = REGULAR_PLURALS[index] ?? ['', ''];
    rules.push(
      [new RegExp(find.toUpperCase()), replacement.toUpperCase()],
      [new RegExp(find), replacement],
      [new RegExp(find, 'i'), replacement]
    );
  }
  return rules;
}

const PLURAL_RULES: PluralRule[] = buildPluralRules();

/** Pluralizes a lower-case snake_case name the way GORM does for table names. */
export function gormPluralize(snake: string): string {
  for (const [pattern, replacement] of PLURAL_RULES) {
    if (pattern.test(snake)) {
      return snake.replace(pattern, replacement);
    }
  }
  return snake;
}

/** The table name GORM derives from a Go struct name: `BlogPost` becomes `blog_posts`. */
export function gormTableName(goTypeName: string): string {
  return gormPluralize(gormColumnName(goTypeName));
}

/**
 * Applies GORM's conventions to a schema: plural snake_case table names (join
 * tables keep theirs), snake_case columns, and `created_at` / `updated_at`
 * where a model has none (GORM fills both in by name). Primary keys keep their
 * type.
 */
export function normalizeGormSchema(schema: IrSchema): IrSchema {
  return {
    ...schema,
    models: schema.models.map((model: IrModel): IrModel =>
      normalizeGormModel(model)
    ),
  };
}

const CREATED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'created_at',
  'created',
  'createdat',
  'date_created',
]);
const UPDATED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'updated_at',
  'updated',
  'updatedat',
  'modified',
  'modified_at',
  'date_updated',
]);

function normalizeGormModel(model: IrModel): IrModel {
  const fields: IrField[] = model.fields.map((field: IrField): IrField => ({
    ...field,
    columnName: toSnakeCase(field.columnName),
  }));
  if (model.isJoinTable !== true) {
    const hasCreated: boolean = fields.some((field: IrField) =>
      CREATED_FIELD_NAMES.has(field.name.toLowerCase())
    );
    const hasUpdated: boolean = fields.some(
      (field: IrField) =>
        field.isAutoUpdated || UPDATED_FIELD_NAMES.has(field.name.toLowerCase())
    );
    if (!hasCreated) {
      fields.push({
        name: 'created_at',
        columnName: 'created_at',
        type: 'dateTime',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: false,
        default: { kind: 'now' },
      });
    }
    if (!hasUpdated) {
      fields.push({
        name: 'updated_at',
        columnName: 'updated_at',
        type: 'dateTime',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: true,
      });
    }
  }
  return {
    ...model,
    tableName:
      model.isJoinTable === true
        ? model.tableName
        : gormTableName(goName(model.name)),
    fields,
    relations: model.relations.map((relation: IrRelation): IrRelation => ({
      ...relation,
      columnName:
        relation.columnName === '' ? '' : toSnakeCase(relation.columnName),
    })),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dialectOf(provider: PrismaProvider): Dialect {
  switch (provider) {
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'sqlserver':
      return 'sqlserver';
    default:
      return 'postgres';
  }
}

/** A name written the way Go programmers write it: `public_id` becomes `PublicID`. */
function goName(raw: string): string {
  const words: string[] = splitWords(raw).map((word: string): string => {
    const upper: string = word.toUpperCase();
    if (GO_INITIALISMS.has(upper)) {
      return upper;
    }
    if (word === upper && word.length > 1 && /[A-Z]/.test(word)) {
      return titleCase(word);
    }
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  });
  return words.join('');
}

/** An exported Go identifier for `raw`, warning when characters had to be dropped or added. */
function exportedName(
  context: EmitContext,
  owner: string,
  raw: string,
  fallback: string
): string {
  let name: string = goName(raw);
  let changed: boolean = /[^A-Za-z0-9_]/.test(raw);
  if (name === '') {
    name = fallback;
    changed = true;
  } else if (/^[0-9]/.test(name)) {
    name = `X${name}`;
    changed = true;
  }
  if (changed) {
    context.warnings.push(
      `${owner}: "${raw}" is not a usable Go identifier; it was written as "${name}".`
    );
  }
  return name;
}

function uniqueName(baseName: string, used: Set<string>): string {
  let candidate: string = baseName;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** A file name stem that is unique ignoring case and that Go does not treat as a test or platform file. */
function uniqueFileStem(typeName: string, used: Set<string>): string {
  let stem: string = toSnakeCase(typeName);
  if (stem === '') {
    stem = 'model';
  }
  const lastWord: string = stem.slice(stem.lastIndexOf('_') + 1);
  if (stem.includes('_') && GO_FILE_SUFFIXES.has(lastWord)) {
    stem = `${stem}_model`;
  }
  let candidate: string = stem;
  let suffix: number = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Escapes a value for a gorm tag: `;` separates entries, so a literal one is written `\;`. */
function tagValue(value: string): string {
  return value.replace(/;/g, '\\;');
}

/** A SQL string literal, for defaults GORM passes to the database as written. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The struct tag literal for the entries of a `gorm:"..."` tag. */
function tagLiteral(entries: string[]): string {
  const body: string = entries
    .join(';')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  const tag: string = `gorm:"${body}"`;
  // eslint-disable-next-line no-control-regex
  if (!tag.includes('`') && !/[\u0000-\u001f\u007f]/.test(tag)) {
    return `\`${tag}\``;
  }
  return JSON.stringify(tag);
}

/** A Go string literal. */
function goString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Lays out rows the way gofmt's tabwriter does: within a run of consecutive
 * rows that all have a cell in a column, that column is as wide as its widest
 * cell plus one space. A row's last cell is never padded.
 */
function alignRows(rows: string[][]): string[] {
  const widths: (number | undefined)[][] = rows.map(
    (row: string[]): (number | undefined)[] => row.map(() => undefined)
  );
  const columnCount: number = Math.max(0, ...rows.map((row) => row.length));
  for (let column: number = 0; column < columnCount - 1; column += 1) {
    let start: number = 0;
    while (start < rows.length) {
      if ((rows[start]?.length ?? 0) <= column + 1) {
        start += 1;
        continue;
      }
      let end: number = start;
      let width: number = 0;
      while (end < rows.length && (rows[end]?.length ?? 0) > column + 1) {
        width = Math.max(width, [...(rows[end]?.[column] ?? '')].length);
        end += 1;
      }
      for (let row: number = start; row < end; row += 1) {
        const rowWidths: (number | undefined)[] | undefined = widths[row];
        if (rowWidths !== undefined) {
          rowWidths[column] = width + 1;
        }
      }
      start = end;
    }
  }
  return rows.map((row: string[], rowIndex: number): string => {
    return row
      .map((cell: string, column: number): string => {
        const width: number | undefined = widths[rowIndex]?.[column];
        return width === undefined
          ? cell
          : cell + ' '.repeat(width - [...cell].length);
      })
      .join('');
  });
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function allocateTypeNames(context: EmitContext): void {
  for (const model of context.schema.models) {
    const name: string = exportedName(context, model.name, model.name, 'Model');
    context.modelTypes.set(model.name, uniqueName(name, context.typeNames));
  }
  for (const enumDefinition of context.schema.enums) {
    const name: string = exportedName(
      context,
      `enum ${enumDefinition.name}`,
      enumDefinition.name,
      'Enum'
    );
    context.enumTypes.set(
      enumDefinition.name,
      uniqueName(name, context.typeNames)
    );
  }
}

/** Constant names of an enum, claimed from the package-level names so they never clash with a type. */
function enumConstantNames(
  context: EmitContext,
  enumDefinition: IrEnum,
  typeName: string
): string[] {
  return enumDefinition.values.map((value: IrEnumValue): string => {
    const suffix: string = goName(value.name);
    return uniqueName(
      `${typeName}${suffix === '' ? 'Value' : suffix}`,
      context.typeNames
    );
  });
}

function findEnum(context: EmitContext, name: string): IrEnum | undefined {
  return context.schema.enums.find(
    (candidate: IrEnum) => candidate.name === name
  );
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

function spec(
  goType: string,
  kind: ValueKind,
  typeEntries: string[] = [],
  imports: GoImport[] = [],
  extra: Partial<ScalarSpec> = {}
): ScalarSpec {
  return {
    goType,
    typeEntries,
    kind,
    imports,
    nilable: false,
    temporal: false,
    ...extra,
  };
}

/** The `type:` entry for a UUID column; SQLite and anything unknown keep GORM's text column. */
function uuidTypeEntries(dialect: Dialect): string[] {
  switch (dialect) {
    case 'postgres':
      return ['type:uuid'];
    case 'mysql':
      return ['type:char(36)'];
    case 'sqlserver':
      return ['type:uniqueidentifier'];
    default:
      return [];
  }
}

function textTypeEntries(dialect: Dialect): string[] {
  switch (dialect) {
    case 'mysql':
      return ['type:longtext'];
    case 'sqlserver':
      return ['type:nvarchar(max)'];
    default:
      return ['type:text'];
  }
}

/**
 * Works out the Go type and the type entries of a column. `report` is false
 * when the same field is looked at again (for example as a referenced key), so
 * its warnings are not repeated.
 */
function scalarSpec(
  context: EmitContext,
  label: string,
  field: IrField,
  report: boolean
): ScalarSpec {
  const warn = (message: string): void => {
    if (report) {
      context.warnings.push(`${label}: ${message}`);
    }
  };
  const base: ScalarSpec = baseSpec(context, field, warn);
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return base;
  }
  warn(
    'GORM has no portable array column type; the array was written as a JSON column (datatypes.JSONSlice).'
  );
  return spec(
    `datatypes.JSONSlice[${'[]'.repeat(depth - 1)}${base.goType}]`,
    'json',
    [],
    ['datatypes', ...base.imports],
    { nilable: true }
  );
}

function baseSpec(
  context: EmitContext,
  field: IrField,
  warn: (message: string) => void
): ScalarSpec {
  const dialect: Dialect = context.dialect;
  const sizeEntry: string[] =
    field.maxLength === undefined ? [] : [`size:${field.maxLength}`];

  if (field.enumName !== undefined) {
    const enumDefinition: IrEnum | undefined = findEnum(
      context,
      field.enumName
    );
    if (enumDefinition === undefined) {
      warn(
        `enum "${field.enumName}" does not exist in the schema; the column was written as a plain string.`
      );
    } else {
      return spec(
        context.enumTypes.get(enumDefinition.name) ?? field.enumName,
        'enum',
        sizeEntry,
        [],
        { enumDefinition }
      );
    }
  }

  switch (field.type) {
    case 'string':
      return spec('string', 'string', sizeEntry);
    case 'text':
      return spec('string', 'string', textTypeEntries(dialect));
    case 'uuid':
      return spec('uuid.UUID', 'uuid', uuidTypeEntries(dialect), ['uuid']);
    case 'int':
      return spec('int32', 'int');
    case 'bigInt':
      return spec('int64', 'int');
    case 'float':
      return spec(
        'float64',
        'float',
        dialect === 'postgres' ? ['type:double precision'] : []
      );
    case 'decimal': {
      if (field.maxDigits !== undefined && field.decimalPlaces !== undefined) {
        return spec(
          'decimal.Decimal',
          'decimal',
          [`type:decimal(${field.maxDigits},${field.decimalPlaces})`],
          ['decimal']
        );
      }
      if (dialect === 'mysql' || dialect === 'sqlserver') {
        warn(
          'a decimal column without precision and scale gets the database default (no decimal places on this provider).'
        );
      }
      return spec('decimal.Decimal', 'decimal', ['type:decimal'], ['decimal']);
    }
    case 'boolean':
      return spec('bool', 'bool');
    case 'dateTime':
      return spec('time.Time', 'time', [], ['time'], { temporal: true });
    case 'date':
      return spec('time.Time', 'time', ['type:date'], ['time'], {
        temporal: true,
      });
    case 'time':
      return spec('time.Time', 'time', ['type:time(6)'], ['time']);
    case 'json':
      return spec('datatypes.JSON', 'json', [], ['datatypes'], {
        nilable: true,
      });
    case 'bytes':
      return spec('[]byte', 'bytes', [], [], { nilable: true });
    case 'duration':
      warn(
        'GORM has no interval column; the duration was written as a time.Duration, stored as nanoseconds in a bigint column.'
      );
      return spec('time.Duration', 'duration', [], ['time']);
    case 'ipAddress':
      return spec('string', 'string', ['size:45']);
    case 'hstore':
      warn(
        'GORM has no hstore type; the field was written as a JSON column (datatypes.JSON).'
      );
      return spec('datatypes.JSON', 'json', [], ['datatypes'], {
        nilable: true,
      });
    case 'range':
      warn(
        'GORM has no range column type; the field was written as a string column holding the range text.'
      );
      return spec('string', 'string');
    case 'unsupported':
      // Without a type name the shared Prisma-only warning already says everything.
      if (field.unsupportedType !== undefined) {
        warn(
          `the database type "${field.unsupportedType}" has no Go type here; the column was written as a string with type:${field.unsupportedType}.`
        );
      }
      return spec(
        'string',
        'string',
        field.unsupportedType === undefined
          ? []
          : [`type:${tagValue(field.unsupportedType)}`]
      );
    default:
      warn(
        `unknown field type "${String(field.type)}"; it was written as a string column.`
      );
      return spec('string', 'string');
  }
}

/** The Go type of a column: a pointer when the column is nullable, unless the type holds nil itself. */
function memberType(columnSpec: ScalarSpec, nullable: boolean): string {
  return nullable && !columnSpec.nilable
    ? `*${columnSpec.goType}`
    : columnSpec.goType;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

interface DefaultEntries {
  entries: string[];
  hook?: Omit<UuidHook, 'member'>;
}

function enumValueFor(
  columnSpec: ScalarSpec,
  raw: string
): IrEnumValue | undefined {
  const values: IrEnumValue[] = columnSpec.enumDefinition?.values ?? [];
  return (
    values.find((candidate: IrEnumValue) => candidate.name === raw) ??
    values.find((candidate: IrEnumValue) => candidate.dbValue === raw)
  );
}

/** Works out the tag entries (and generated-UUID hook) that implement a field's default. */
function defaultOf(
  context: EmitContext,
  label: string,
  field: IrField,
  columnSpec: ScalarSpec
): DefaultEntries {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return { entries: [] };
  }
  switch (defaultValue.kind) {
    case 'autoIncrement':
      return { entries: [] };
    case 'now':
      if (columnSpec.temporal) {
        return {
          entries: [
            'autoCreateTime',
            ...(field.isDbDefault === true
              ? ['default:CURRENT_TIMESTAMP']
              : []),
          ],
        };
      }
      if (columnSpec.kind === 'string' || columnSpec.kind === 'time') {
        return { entries: ['default:CURRENT_TIMESTAMP'] };
      }
      context.warnings.push(
        `${label}: a "now" default needs a date or time column; it was dropped.`
      );
      return { entries: [] };
    case 'uuid': {
      if (columnSpec.kind !== 'uuid' && columnSpec.kind !== 'string') {
        context.warnings.push(
          `${label}: a UUID default needs a uuid or string column; it was dropped.`
        );
        return { entries: [] };
      }
      const version: number | undefined = defaultValue.version;
      if (version !== undefined && version !== 4 && version !== 7) {
        context.warnings.push(
          `${label}: a version ${version} UUID default was written as a random (version 4) UUID.`
        );
      }
      const style: UuidHook['style'] =
        columnSpec.kind === 'string'
          ? 'string'
          : field.isNullable
            ? 'pointer'
            : 'value';
      if (context.dialect === 'postgres' && version !== 7) {
        return { entries: ['default:gen_random_uuid()'] };
      }
      return {
        entries: [],
        hook: { style, version7: version === 7 },
      };
    }
    case 'enumValue': {
      const found: IrEnumValue | undefined = enumValueFor(
        columnSpec,
        defaultValue.value
      );
      if (found === undefined) {
        context.warnings.push(
          `${label}: the enum default "${defaultValue.value}" does not match a value of the enum; it was dropped.`
        );
        return { entries: [] };
      }
      return { entries: [`default:${tagValue(found.dbValue)}`] };
    }
    case 'literal':
      return literalDefault(
        context,
        label,
        field,
        columnSpec,
        defaultValue.value
      );
    case 'dbExpression':
      return defaultValue.isFunction === true
        ? { entries: [] }
        : { entries: [`default:${tagValue(defaultValue.expression)}`] };
    default:
      // clientGenerated defaults are reported by prismaOnlyWarnings.
      return { entries: [] };
  }
}

function literalDefault(
  context: EmitContext,
  label: string,
  field: IrField,
  columnSpec: ScalarSpec,
  value: string | number | boolean
): DefaultEntries {
  const text: string = String(value);
  switch (columnSpec.kind) {
    case 'enum': {
      const found: IrEnumValue | undefined = enumValueFor(columnSpec, text);
      if (found === undefined) {
        context.warnings.push(
          `${label}: the enum default "${text}" does not match a value of the enum; it was dropped.`
        );
        return { entries: [] };
      }
      return { entries: [`default:${tagValue(found.dbValue)}`] };
    }
    case 'string':
      return { entries: [`default:${tagValue(text)}`] };
    case 'bool':
      return {
        entries: [`default:${value === true || value === 'true'}`],
      };
    case 'int':
      return { entries: [`default:${Math.trunc(Number(value))}`] };
    case 'float':
      return { entries: [`default:${Number(value)}`] };
    case 'decimal':
      return {
        entries: [
          `default:${
            Number.isNaN(Number(text)) || text.trim() === ''
              ? tagValue(sqlString(text))
              : tagValue(text)
          }`,
        ],
      };
    case 'json':
    case 'uuid':
    case 'time':
      return { entries: [`default:${tagValue(sqlString(text))}`] };
    default:
      context.warnings.push(
        `${label}: a literal default on a ${field.type} column cannot be represented; it was dropped.`
      );
      return { entries: [] };
  }
}

// ---------------------------------------------------------------------------
// Planning: structs and columns
// ---------------------------------------------------------------------------

interface GormModelFields {
  id: IrField;
  createdAt: IrField;
  updatedAt: IrField;
  deletedAt: IrField;
}

function isPlainTimestamp(field: IrField): boolean {
  return (
    field.type === 'dateTime' &&
    !field.isUnique &&
    field.enumName === undefined &&
    (field.arrayDepth ?? 0) === 0 &&
    field.generated === undefined
  );
}

/**
 * Finds the four columns of `gorm.Model` when the model has exactly those:
 * a big-integer auto-increment `id` key, date-time `created_at` and
 * `updated_at` (the latter refreshed on update), and a nullable, indexed
 * `deleted_at`.
 */
function findGormModelFields(model: IrModel): GormModelFields | undefined {
  if (
    (model.compositePrimaryKey?.length ?? 0) > 0 ||
    model.relations.some((relation: IrRelation) => relation.isPrimaryKey)
  ) {
    return undefined;
  }
  const byColumn = (column: string): IrField | undefined =>
    model.fields.find((field: IrField) => field.columnName === column);
  const id: IrField | undefined = byColumn('id');
  const createdAt: IrField | undefined = byColumn('created_at');
  const updatedAt: IrField | undefined = byColumn('updated_at');
  const deletedAt: IrField | undefined = byColumn('deleted_at');
  if (
    id === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    deletedAt === undefined
  ) {
    return undefined;
  }
  const onlyKey: boolean =
    model.fields.filter((field: IrField) => field.isPrimaryKey).length === 1;
  const idMatches: boolean =
    onlyKey &&
    id.isPrimaryKey &&
    id.type === 'bigInt' &&
    id.default?.kind === 'autoIncrement' &&
    !id.isNullable &&
    id.enumName === undefined &&
    (id.arrayDepth ?? 0) === 0;
  const createdMatches: boolean =
    isPlainTimestamp(createdAt) &&
    !createdAt.isPrimaryKey &&
    (createdAt.default === undefined || createdAt.default.kind === 'now');
  const updatedMatches: boolean =
    isPlainTimestamp(updatedAt) &&
    !updatedAt.isPrimaryKey &&
    updatedAt.isAutoUpdated &&
    updatedAt.default === undefined;
  const deletedMatches: boolean =
    isPlainTimestamp(deletedAt) &&
    !deletedAt.isPrimaryKey &&
    deletedAt.isNullable &&
    deletedAt.default === undefined;
  const deletedIndexed: boolean = model.indexes.some(
    (index: IrIndex) =>
      index.fields.length === 1 &&
      index.fields[0] === deletedAt.name &&
      !index.isUnique &&
      index.name === undefined &&
      index.kind === undefined &&
      index.method === undefined
  );
  if (
    idMatches &&
    createdMatches &&
    updatedMatches &&
    deletedMatches &&
    deletedIndexed
  ) {
    return { id, createdAt, updatedAt, deletedAt };
  }
  return undefined;
}

/** True for a nullable `deleted_at` timestamp, which GORM calls soft delete. */
function isSoftDeleteField(field: IrField): boolean {
  return (
    isPlainTimestamp(field) &&
    field.isNullable &&
    field.default === undefined &&
    toSnakeCase(field.columnName) === 'deleted_at'
  );
}

function planStruct(context: EmitContext, model: IrModel): void {
  const typeName: string = context.modelTypes.get(model.name) ?? model.name;
  const plan: StructPlan = {
    model,
    typeName,
    fileStem: '',
    embedsModel: false,
    members: [],
    names: new Set<string>(RESERVED_MEMBER_NAMES),
    imports: new Set<GoImport>(),
    fieldNames: new Map<string, string>(),
    byKey: new Map<string, Member>(),
    owned: new Map<string, OwnedRelation>(),
    manyToMany: new Set<string>(),
    uuidHooks: [],
  };
  context.plans.set(model.name, plan);

  const embedded: GormModelFields | undefined = findGormModelFields(model);
  const embeddedFields: Set<IrField> = new Set<IrField>();
  if (embedded !== undefined) {
    plan.embedsModel = true;
    plan.imports.add('gorm');
    for (const name of GORM_MODEL_MEMBERS) {
      plan.names.add(name);
    }
    plan.members.push({
      name: '',
      type: 'gorm.Model',
      entries: [],
      role: 'column',
    });
    const pairs: [IrField, string][] = [
      [embedded.id, 'ID'],
      [embedded.createdAt, 'CreatedAt'],
      [embedded.updatedAt, 'UpdatedAt'],
      [embedded.deletedAt, 'DeletedAt'],
    ];
    for (const [field, name] of pairs) {
      embeddedFields.add(field);
      plan.fieldNames.set(field.name, name);
    }
  }

  const hasPrimaryKey: boolean =
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some((relation: IrRelation) => relation.isPrimaryKey) ||
    (model.compositePrimaryKey?.length ?? 0) > 0;
  if (!hasPrimaryKey) {
    context.warnings.push(
      `${model.name}: the model has no primary key; GORM can still read and create rows, but updates and deletes by key need one.`
    );
  }

  for (const field of model.fields) {
    if (!embeddedFields.has(field)) {
      planField(context, plan, field);
    }
  }
}

function planField(
  context: EmitContext,
  plan: StructPlan,
  field: IrField
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${field.name}`;
  const name: string = uniqueName(
    exportedName(context, label, field.name, 'Field'),
    plan.names
  );
  plan.fieldNames.set(field.name, name);

  const columnSpec: ScalarSpec = scalarSpec(context, label, field, true);
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} is not SQL GORM can run; the field was written as a regular column.`
    );
  }

  const inComposite: boolean =
    model.compositePrimaryKey?.includes(field.name) ?? false;
  const isKey: boolean = field.isPrimaryKey || inComposite;
  const entries: string[] = [];
  if (gormColumnName(name) !== field.columnName) {
    entries.push(`column:${tagValue(field.columnName)}`);
  }

  const softDelete: boolean = !isKey && isSoftDeleteField(field);
  let type: string = memberType(columnSpec, field.isNullable);
  if (!softDelete) {
    for (const imported of columnSpec.imports) {
      plan.imports.add(imported);
    }
  }
  if (softDelete) {
    type = 'gorm.DeletedAt';
    plan.imports.add('gorm');
    context.warnings.push(
      `${label}: a nullable deleted_at timestamp was written as gorm.DeletedAt, so GORM treats ${model.name} as soft-deleted: queries skip rows where it is set and Delete only sets it.`
    );
  } else {
    entries.push(...columnSpec.typeEntries);
  }

  const incrementing: boolean =
    field.default?.kind === 'autoIncrement' && columnSpec.kind === 'int';
  if (field.default?.kind === 'autoIncrement' && !incrementing) {
    context.warnings.push(
      `${label}: an auto-increment default is only supported on integer columns; it was dropped.`
    );
  }
  if (isKey) {
    entries.push('primaryKey');
  }
  if (incrementing) {
    entries.push('autoIncrement');
  } else if (
    isKey &&
    !inComposite &&
    columnSpec.kind === 'int' &&
    model.fields.filter((candidate: IrField) => candidate.isPrimaryKey)
      .length === 1
  ) {
    // GORM makes a lone integer key auto-increment unless told otherwise.
    entries.push('autoIncrement:false');
  }
  if (!isKey && !field.isNullable && !softDelete) {
    entries.push('not null');
  }
  if (!isKey && field.isUnique) {
    entries.push(
      field.uniqueName === undefined
        ? 'unique'
        : `uniqueIndex:${tagValue(field.uniqueName)}`
    );
  }

  if (!softDelete) {
    const defaults: DefaultEntries = defaultOf(
      context,
      label,
      field,
      columnSpec
    );
    entries.push(...defaults.entries);
    if (defaults.hook !== undefined) {
      plan.uuidHooks.push({ member: name, ...defaults.hook });
      plan.imports.add('uuid');
      plan.imports.add('gorm');
    }
  }
  if (field.isAutoUpdated) {
    if (columnSpec.temporal) {
      entries.push('autoUpdateTime');
    } else {
      context.warnings.push(
        `${label}: an auto-updated field must be a date or time column; it was written as a plain column.`
      );
    }
  }

  const member: Member = { name, type, entries, role: 'column' };
  plan.members.push(member);
  plan.byKey.set(`f:${field.name}`, member);
}

// ---------------------------------------------------------------------------
// Planning: relations
// ---------------------------------------------------------------------------

interface ReferencedKey {
  /** Go field name of the key on the target struct. */
  goName: string;
  spec: ScalarSpec;
  isPrimaryKey: boolean;
}

/** The single-column key a relation points at: an explicit `toField`, otherwise the primary key. */
function referencedKey(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): ReferencedKey | undefined {
  const targetPlan: StructPlan | undefined = context.plans.get(target.name);
  if (depth > 5 || targetPlan === undefined) {
    return undefined;
  }
  const label: string = `${target.name}`;
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find((field: IrField) => field.name === toField);
  if (explicit !== undefined) {
    return {
      goName: targetPlan.fieldNames.get(explicit.name) ?? explicit.name,
      spec: scalarSpec(context, label, explicit, false),
      isPrimaryKey: explicit.isPrimaryKey,
    };
  }
  const keys: IrField[] = target.fields.filter(
    (field: IrField) => field.isPrimaryKey
  );
  const compositeLength: number = target.compositePrimaryKey?.length ?? 0;
  const keyedRelations: IrRelation[] = target.relations.filter(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (
    keys.length === 1 &&
    compositeLength === 0 &&
    keyedRelations.length === 0
  ) {
    const key: IrField = keys[0] as IrField;
    return {
      goName: targetPlan.fieldNames.get(key.name) ?? key.name,
      spec: scalarSpec(context, label, key, false),
      isPrimaryKey: true,
    };
  }
  if (
    keys.length === 0 &&
    compositeLength === 0 &&
    keyedRelations.length === 1
  ) {
    // Multi-table inheritance: the key is itself a foreign key to the parent.
    const relation: IrRelation = keyedRelations[0] as IrRelation;
    const parent: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    const inherited: ReferencedKey | undefined =
      parent === undefined
        ? undefined
        : referencedKey(context, parent, relation.toField, depth + 1);
    return inherited === undefined
      ? undefined
      : { ...inherited, goName: 'ID', isPrimaryKey: true };
  }
  return undefined;
}

function isKeyedRelation(model: IrModel, relation: IrRelation): boolean {
  return (
    relation.isPrimaryKey === true ||
    (model.compositePrimaryKey?.includes(relation.name) ?? false)
  );
}

/** True when `from` can reach `to` by holding structs by value. */
function reachesByValue(
  context: EmitContext,
  from: string,
  to: string,
  seen: Set<string> = new Set<string>()
): boolean {
  if (from === to) {
    return true;
  }
  if (seen.has(from)) {
    return false;
  }
  seen.add(from);
  for (const next of context.valueEdges.get(from) ?? []) {
    if (reachesByValue(context, next, to, seen)) {
      return true;
    }
  }
  return false;
}

/** The `constraint:` entry for the referential actions of a relation, or undefined when GORM's defaults apply. */
function constraintEntry(relation: IrRelation): string | undefined {
  const actions: string[] = [];
  if (relation.onUpdate !== undefined && relation.onUpdate !== 'noAction') {
    actions.push(`OnUpdate:${ON_DELETE_NAMES[relation.onUpdate]}`);
  }
  if (relation.onDelete !== 'noAction') {
    actions.push(`OnDelete:${ON_DELETE_NAMES[relation.onDelete]}`);
  }
  if (actions.length === 0) {
    return undefined;
  }
  // A name is only recognized by GORM when it is letters, underscores and hyphens.
  const named: boolean =
    relation.constraintName !== undefined &&
    /^[A-Za-z_-]+$/.test(relation.constraintName);
  return `constraint:${named ? `${relation.constraintName ?? ''},` : ''}${actions.join(',')}`;
}

function planOwnedRelations(context: EmitContext, model: IrModel): void {
  const plan: StructPlan | undefined = context.plans.get(model.name);
  if (plan === undefined) {
    return;
  }
  for (const relation of model.relations) {
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    const label: string = `${model.name}.${relation.name}`;
    if (target === undefined) {
      context.warnings.push(
        `${label}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      continue;
    }
    if (relation.kind === 'manyToMany') {
      planManyToMany(context, plan, relation, target);
    } else {
      planToOne(context, plan, relation, target);
    }
  }
}

function planToOne(
  context: EmitContext,
  plan: StructPlan,
  relation: IrRelation,
  target: IrModel
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const key: ReferencedKey | undefined = referencedKey(
    context,
    target,
    relation.toField
  );
  const targetPlan: StructPlan | undefined = context.plans.get(target.name);
  if (key === undefined || targetPlan === undefined) {
    context.warnings.push(
      `${label}: target model "${target.name}" has no single-column primary key to reference; the relation was skipped.`
    );
    return;
  }
  if (relation.onDelete === 'setNull' && !relation.isNullable) {
    context.warnings.push(
      `${label}: onDelete SET NULL on a required relation will fail at the database level; review the relation.`
    );
  }
  const keyed: boolean = isKeyedRelation(model, relation);
  const nullable: boolean = relation.isNullable && !keyed;
  const baseName: string = exportedName(context, label, relation.name, 'Rel');
  const associationName: string = uniqueName(baseName, plan.names);
  const foreignKeyName: string = uniqueName(
    `${baseName}${key.goName}`,
    plan.names
  );
  for (const imported of key.spec.imports) {
    plan.imports.add(imported);
  }

  const column: string =
    relation.columnName === ''
      ? `${toSnakeCase(relation.name)}_id`
      : relation.columnName;
  const foreignKeyEntries: string[] = [];
  if (gormColumnName(foreignKeyName) !== column) {
    foreignKeyEntries.push(`column:${tagValue(column)}`);
  }
  foreignKeyEntries.push(...key.spec.typeEntries);
  if (keyed) {
    foreignKeyEntries.push('primaryKey');
    if (
      key.spec.kind === 'int' &&
      (model.compositePrimaryKey?.length ?? 0) === 0
    ) {
      foreignKeyEntries.push('autoIncrement:false');
    }
  } else {
    if (!nullable) {
      foreignKeyEntries.push('not null');
    }
    if (relation.kind === 'oneToOne') {
      foreignKeyEntries.push('unique');
    }
  }
  const foreignKey: Member = {
    name: foreignKeyName,
    type: memberType(key.spec, nullable),
    entries: foreignKeyEntries,
    role: 'column',
  };

  // A struct holds a required, non-recursive parent by value; anything else is
  // a pointer so the generated types stay finite.
  const byValue: boolean =
    !nullable &&
    target.name !== model.name &&
    !reachesByValue(context, target.name, model.name);
  if (byValue) {
    const edges: Set<string> =
      context.valueEdges.get(model.name) ?? new Set<string>();
    edges.add(target.name);
    context.valueEdges.set(model.name, edges);
  }
  const constraint: string | undefined = constraintEntry(relation);
  const references: string | undefined =
    relation.toField !== undefined && !key.isPrimaryKey
      ? key.goName
      : undefined;
  const association: Member = {
    name: associationName,
    type: `${byValue ? '' : '*'}${targetPlan.typeName}`,
    entries: [
      `foreignKey:${foreignKeyName}`,
      ...(references === undefined ? [] : [`references:${references}`]),
      ...(constraint === undefined ? [] : [constraint]),
    ],
    role: 'association',
  };
  plan.members.push(foreignKey, association);
  plan.byKey.set(`r:${relation.name}`, foreignKey);
  plan.owned.set(relation.name, {
    relation,
    target,
    foreignKey,
    association,
    ...(references === undefined ? {} : { references }),
    ...(constraint === undefined ? {} : { constraint }),
  });
}

/** The join table and the columns that point at each side of a many-to-many relation. */
interface JoinPlan {
  table: string;
  ownerColumn: string;
  targetColumn: string;
}

function joinPlanOf(model: IrModel, relation: IrRelation): JoinPlan {
  const isSelfReference: boolean = model.name === relation.targetModel;
  return {
    table: `${model.tableName}_${relation.name}`,
    ownerColumn: `${isSelfReference ? 'from_' : ''}${toSnakeCase(model.name)}_id`,
    targetColumn: `${isSelfReference ? 'to_' : ''}${toSnakeCase(relation.targetModel)}_id`,
  };
}

/**
 * The tag entries of one side of a many-to-many relation. GORM names the join
 * columns `<Struct><Key>` and `<Target><Key>`; `joinForeignKey` and
 * `joinReferences` are only written when the columns differ from that.
 */
function manyToManyEntries(
  join: JoinPlan,
  ownColumn: string,
  otherColumn: string,
  defaultOwnColumn: string,
  defaultOtherColumn: string,
  isSelfReference: boolean
): string[] {
  // Both sides carry the actions: GORM builds the join table from whichever struct it migrates first.
  const entries: string[] = [`many2many:${tagValue(join.table)}`];
  if (isSelfReference || ownColumn !== defaultOwnColumn) {
    entries.push(`joinForeignKey:${tagValue(ownColumn)}`);
  }
  if (isSelfReference || otherColumn !== defaultOtherColumn) {
    entries.push(`joinReferences:${tagValue(otherColumn)}`);
  }
  entries.push('constraint:OnDelete:CASCADE');
  return entries;
}

function planManyToMany(
  context: EmitContext,
  plan: StructPlan,
  relation: IrRelation,
  target: IrModel
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const targetPlan: StructPlan | undefined = context.plans.get(target.name);
  const ownerKey: ReferencedKey | undefined = referencedKey(
    context,
    model,
    undefined
  );
  const targetKey: ReferencedKey | undefined = referencedKey(
    context,
    target,
    undefined
  );
  if (
    targetPlan === undefined ||
    ownerKey === undefined ||
    targetKey === undefined
  ) {
    context.warnings.push(
      `${label}: ${ownerKey === undefined ? model.name : target.name} has no single-column primary key to reference from a join table; the relation was skipped.`
    );
    return;
  }
  const join: JoinPlan = joinPlanOf(model, relation);
  if (join.table !== join.table.toLowerCase()) {
    context.warnings.push(
      `${label}: GORM lower-cases and pluralizes a join table name that has capital letters, so "${join.table}" will not be used as written.`
    );
  }
  const isSelfReference: boolean = model.name === target.name;
  const name: string = uniqueName(
    exportedName(context, label, relation.name, 'Rel'),
    plan.names
  );
  plan.members.push({
    name,
    type: `[]${targetPlan.typeName}`,
    entries: manyToManyEntries(
      join,
      join.ownerColumn,
      join.targetColumn,
      gormColumnName(`${plan.typeName}${ownerKey.goName}`),
      gormColumnName(`${targetPlan.typeName}${targetKey.goName}`),
      isSelfReference
    ),
    role: 'association',
  });
  plan.manyToMany.add(relation.name);
}

/** The name an unnamed reverse relation gets: the model's plural (`Posts`), or its name for a one-to-one. */
function defaultInverseName(typeName: string, plural: boolean): string {
  return plural ? goName(gormTableName(typeName)) : typeName;
}

function planInverseSides(context: EmitContext, model: IrModel): void {
  const plan: StructPlan | undefined = context.plans.get(model.name);
  if (plan === undefined) {
    return;
  }
  for (const relation of model.relations) {
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    const targetPlan: StructPlan | undefined =
      target === undefined ? undefined : context.plans.get(target.name);
    if (target === undefined || targetPlan === undefined) {
      continue;
    }
    const label: string = `${model.name}.${relation.name}`;
    if (relation.kind === 'manyToMany') {
      planInverseManyToMany(context, plan, relation, target, targetPlan);
      continue;
    }
    const owned: OwnedRelation | undefined = plan.owned.get(relation.name);
    if (owned === undefined) {
      continue;
    }
    const many: boolean = relation.kind !== 'oneToOne';
    const raw: string =
      relation.relatedName ?? defaultInverseName(plan.typeName, many);
    const name: string = uniqueName(
      exportedName(context, label, raw, 'Related'),
      targetPlan.names
    );
    targetPlan.members.push({
      name,
      type: many ? `[]${plan.typeName}` : `*${plan.typeName}`,
      entries: [
        `foreignKey:${owned.foreignKey.name}`,
        ...(owned.references === undefined
          ? []
          : [`references:${owned.references}`]),
        ...(owned.constraint === undefined ? [] : [owned.constraint]),
      ],
      role: 'association',
    });
  }
}

function planInverseManyToMany(
  context: EmitContext,
  plan: StructPlan,
  relation: IrRelation,
  target: IrModel,
  targetPlan: StructPlan
): void {
  const model: IrModel = plan.model;
  const ownerKey: ReferencedKey | undefined = referencedKey(
    context,
    model,
    undefined
  );
  const targetKey: ReferencedKey | undefined = referencedKey(
    context,
    target,
    undefined
  );
  if (
    ownerKey === undefined ||
    targetKey === undefined ||
    !plan.manyToMany.has(relation.name)
  ) {
    return;
  }
  const label: string = `${model.name}.${relation.name}`;
  const join: JoinPlan = joinPlanOf(model, relation);
  const raw: string =
    relation.relatedName ?? defaultInverseName(plan.typeName, true);
  const name: string = uniqueName(
    exportedName(context, label, raw, 'Related'),
    targetPlan.names
  );
  targetPlan.members.push({
    name,
    type: `[]${plan.typeName}`,
    entries: manyToManyEntries(
      join,
      join.targetColumn,
      join.ownerColumn,
      gormColumnName(`${targetPlan.typeName}${targetKey.goName}`),
      gormColumnName(`${plan.typeName}${ownerKey.goName}`),
      model.name === target.name
    ),
    role: 'association',
  });
}

// ---------------------------------------------------------------------------
// Planning: indexes
// ---------------------------------------------------------------------------

function planIndexes(context: EmitContext, model: IrModel): void {
  const plan: StructPlan | undefined = context.plans.get(model.name);
  if (plan === undefined) {
    return;
  }
  for (const index of model.indexes) {
    const label: string = `${model.name} index (${index.fields.join(', ')})`;
    if (plan.embedsModel && isEmbeddedSoftDeleteIndex(plan, index)) {
      continue;
    }
    const members: Member[] = [];
    const columns: string[] = [];
    let resolved: boolean = true;
    for (const fieldName of index.fields) {
      const member: Member | undefined =
        plan.byKey.get(`r:${fieldName}`) ?? plan.byKey.get(`f:${fieldName}`);
      const byColumn: IrField | undefined = model.fields.find(
        (candidate: IrField) => candidate.columnName === fieldName
      );
      const resolvedMember: Member | undefined =
        member ??
        (byColumn === undefined
          ? undefined
          : plan.byKey.get(`f:${byColumn.name}`));
      if (resolvedMember === undefined) {
        context.warnings.push(
          `${label}: "${fieldName}" is not a column of the model (or belongs to gorm.Model); the index was skipped.`
        );
        resolved = false;
        break;
      }
      members.push(resolvedMember);
      columns.push(columnOf(resolvedMember, model));
    }
    if (!resolved || members.length === 0) {
      continue;
    }
    addIndexEntries(model, index, members, columns);
  }
}

/** True for the plain `deleted_at` index that `gorm.Model` already declares. */
function isEmbeddedSoftDeleteIndex(plan: StructPlan, index: IrIndex): boolean {
  return (
    index.fields.length === 1 &&
    plan.fieldNames.get(index.fields[0] ?? '') === 'DeletedAt' &&
    !index.isUnique &&
    index.name === undefined
  );
}

/** The column name of a member, read back from its tag or derived from its Go name. */
function columnOf(member: Member, model: IrModel): string {
  const explicit: string | undefined = member.entries
    .find((entry: string) => entry.startsWith('column:'))
    ?.slice('column:'.length);
  if (explicit !== undefined) {
    return explicit;
  }
  const derived: string = gormColumnName(member.name);
  return derived === '' ? model.tableName : derived;
}

function addIndexEntries(
  model: IrModel,
  index: IrIndex,
  members: Member[],
  columns: string[]
): void {
  const keyword: string = index.isUnique ? 'uniqueIndex' : 'index';
  if (members.length === 1) {
    const member: Member = members[0] as Member;
    const alreadyUnique: boolean = member.entries.some(
      (entry: string) => entry === 'unique' || entry.startsWith('uniqueIndex')
    );
    if (index.isUnique && alreadyUnique && index.name === undefined) {
      return;
    }
    member.entries.push(
      index.name === undefined ? keyword : `${keyword}:${tagValue(index.name)}`
    );
    return;
  }
  // GORM only joins columns into one index through a shared index name.
  const name: string =
    index.name ??
    `${index.isUnique ? 'uni' : 'idx'}_${model.tableName}_${columns.join('_')}`;
  members.forEach((member: Member, position: number): void => {
    member.entries.push(
      `${keyword}:${tagValue(name)},priority:${position + 1}`
    );
  });
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** Drops prismaOnlyWarnings lines for things this emitter does write (onUpdate actions, database default expressions). */
function removeHandledWarnings(context: EmitContext): void {
  const handled: Set<string> = new Set<string>();
  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      if (relation.onUpdate !== undefined) {
        handled.add(
          `${model.name}.${relation.name}: the onUpdate action "${relation.onUpdate}" is not supported by this format and was ignored.`
        );
      }
    }
    for (const field of model.fields) {
      if (field.type === 'unsupported' && field.unsupportedType !== undefined) {
        handled.add(
          `${model.name}.${field.name}: the database type "${field.unsupportedType}" (Prisma Unsupported) has no equivalent here; the column was written as a plain string.`
        );
      }
      if (
        field.default?.kind === 'dbExpression' &&
        field.default.isFunction !== true
      ) {
        handled.add(
          `${model.name}.${field.name}: the database default expression ${field.default.expression} was dropped.`
        );
      }
    }
  }
  const kept: string[] = context.warnings.filter(
    (warning: string) => !handled.has(warning)
  );
  context.warnings.splice(0, context.warnings.length, ...kept);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeader(
  context: EmitContext,
  imports: Iterable<GoImport>
): string[] {
  const paths: string[] = [...imports].map(
    (name: GoImport) => IMPORT_PATHS[name]
  );
  // gofmt keeps the import groups apart and sorts each: the standard library first.
  const standard: string[] = paths
    .filter((path: string) => !path.includes('.'))
    .sort();
  const external: string[] = paths
    .filter((path: string) => path.includes('.'))
    .sort();
  const lines: string[] = [`package ${context.packageName}`, ''];
  if (paths.length === 1) {
    lines.push(`import ${goString(paths[0] ?? '')}`, '');
  } else if (paths.length > 1) {
    lines.push('import (');
    for (const path of standard) {
      lines.push(`${INDENT}${goString(path)}`);
    }
    if (standard.length > 0 && external.length > 0) {
      lines.push('');
    }
    for (const path of external) {
      lines.push(`${INDENT}${goString(path)}`);
    }
    lines.push(')', '');
  }
  return lines;
}

function renderEnum(
  context: EmitContext,
  enumDefinition: IrEnum,
  typeName: string
): string {
  const lines: string[] = [
    ...renderHeader(context, []),
    `// ${typeName} is a database enum, stored as text.`,
    `type ${typeName} string`,
  ];
  if (enumDefinition.values.length > 0) {
    const names: string[] = enumConstantNames(
      context,
      enumDefinition,
      typeName
    );
    const rows: string[][] = enumDefinition.values.map(
      (value: IrEnumValue, position: number): string[] => [
        names[position] ?? '',
        typeName,
        `= ${goString(value.dbValue)}`,
        ...(value.label === undefined || value.label === ''
          ? []
          : [`// ${value.label.replace(/\s+/g, ' ')}`]),
      ]
    );
    lines.push(
      '',
      'const (',
      ...alignRows(rows).map((line: string) => `${INDENT}${line}`),
      ')'
    );
  }
  lines.push('');
  return lines.join('\n');
}

function memberRow(member: Member): string[] {
  if (member.name === '') {
    return [member.type];
  }
  const row: string[] = [member.name, member.type];
  if (member.entries.length > 0) {
    row.push(tagLiteral(member.entries));
  }
  return row;
}

/** Struct lines: columns first, then associations; each group is aligned on its own. */
function renderMembers(plan: StructPlan): string[] {
  const columns: Member[] = plan.members.filter(
    (member: Member) => member.role === 'column'
  );
  const associations: Member[] = plan.members.filter(
    (member: Member) => member.role === 'association'
  );
  const groups: string[][] = [columns, associations]
    .filter((group: Member[]) => group.length > 0)
    .map((group: Member[]): string[] =>
      alignRows(group.map(memberRow)).map((line: string) => `${INDENT}${line}`)
    );
  return groups.flatMap((group: string[], position: number): string[] =>
    position === 0 ? group : ['', ...group]
  );
}

function receiverName(typeName: string): string {
  return typeName.charAt(0).toLowerCase();
}

function renderUuidHook(plan: StructPlan): string[] {
  const receiver: string = receiverName(plan.typeName);
  const body: string[] = [];
  for (const hook of plan.uuidHooks) {
    const field: string = `${receiver}.${hook.member}`;
    const empty: string =
      hook.style === 'string'
        ? `${field} == ""`
        : hook.style === 'pointer'
          ? `${field} == nil`
          : `${field} == uuid.Nil`;
    body.push(`${INDENT}if ${empty} {`);
    if (hook.version7) {
      body.push(
        `${INDENT}${INDENT}id, err := uuid.NewV7()`,
        `${INDENT}${INDENT}if err != nil {`,
        `${INDENT}${INDENT}${INDENT}return err`,
        `${INDENT}${INDENT}}`
      );
      body.push(
        `${INDENT}${INDENT}${field} = ${hook.style === 'string' ? 'id.String()' : hook.style === 'pointer' ? '&id' : 'id'}`
      );
    } else if (hook.style === 'string') {
      body.push(`${INDENT}${INDENT}${field} = uuid.NewString()`);
    } else if (hook.style === 'pointer') {
      body.push(
        `${INDENT}${INDENT}id := uuid.New()`,
        `${INDENT}${INDENT}${field} = &id`
      );
    } else {
      body.push(`${INDENT}${INDENT}${field} = uuid.New()`);
    }
    body.push(`${INDENT}}`);
  }
  return [
    '// BeforeCreate fills in generated UUIDs that were left empty.',
    `func (${receiver} *${plan.typeName}) BeforeCreate(tx *gorm.DB) error {`,
    ...body,
    `${INDENT}return nil`,
    '}',
  ];
}

function renderStruct(context: EmitContext, plan: StructPlan): string {
  const members: string[] = renderMembers(plan);
  const lines: string[] = [
    ...renderHeader(context, plan.imports),
    `// ${plan.typeName} maps to the ${goString(plan.model.tableName)} table.`,
    members.length === 0
      ? `type ${plan.typeName} struct{}`
      : `type ${plan.typeName} struct {`,
    ...members,
    ...(members.length === 0 ? [] : ['}']),
  ];
  if (plan.tableName !== undefined) {
    lines.push(
      '',
      `// TableName overrides GORM's default table name (${gormTableName(plan.typeName)}).`,
      `func (${plan.typeName}) TableName() string {`,
      `${INDENT}return ${goString(plan.tableName)}`,
      '}'
    );
  }
  if (plan.uuidHooks.length > 0) {
    lines.push('', ...renderUuidHook(plan));
  }
  lines.push('');
  return lines.join('\n');
}
