import {
  compact,
  INDENT,
  MAX_LINE_WIDTH,
  objectLines,
} from './sequelizeText.js';

/**
 * The text of the Sequelize 7 (`@sequelize/core`) output: decorated classes, one file per model, and an `index`
 * file that lists the models for `new Sequelize({ dialect, models })`. The caller works out what each model
 * holds (the same plan the Sequelize 6 styles use); this module only spells it the Sequelize 7 way.
 *
 * - Columns are `@Attribute(DataTypes.X)` with `@PrimaryKey`, `@AutoIncrement`, `@NotNull`, `@Unique`,
 *   `@Default(...)` and `@ColumnName('column')` for what Sequelize 6 wrote as attribute options.
 * - The `createdAt` / `updatedAt` columns Sequelize adds itself are `@CreatedAt` / `@UpdatedAt` properties.
 * - A relation is declared once, on the model that holds the key (`@BelongsTo` with an `inverse` option that
 *   also defines the other side); the other side is a typed `declare` property. A self reference is declared
 *   from the `@HasMany` / `@HasOne` side instead, because Sequelize 7 cannot build the inverse of a
 *   self-referencing `@BelongsTo`.
 * - A foreign key's `onDelete` and `onUpdate` sit in its `foreignKey` option, not in the association options.
 */

/** One property of a model class. */
export interface V7Attribute {
  name: string;
  /** The data type expression (`DataTypes.STRING(200)`). */
  type: string;
  /** The Sequelize 6 attribute options (`primaryKey: true`, `defaultValue: 0`, `field: 'x'`, ...). */
  entries: string[];
  /** The TypeScript type of the property, without `null`. */
  ts: string;
  nullable: boolean;
  /** True when `CreationOptional` makes the property optional in `create()`. */
  optional: boolean;
  isReadonly: boolean;
  /** Set for a createdAt / updatedAt column that Sequelize adds itself. */
  timestamp?: 'created' | 'updated';
}

/** One association property: a decorated one, or (without a decorator) the typed other side of one. */
export interface V7Association {
  decorator?: 'BelongsTo' | 'HasMany' | 'HasOne' | 'BelongsToMany';
  /** The property name, which is the association alias. */
  alias: string;
  target: string;
  /** True for an array (`hasMany`, `belongsToMany`). */
  many: boolean;
  /** The entries of the decorator's option object. */
  options: string[];
}

export interface V7Model {
  className: string;
  attributes: V7Attribute[];
  /** `tableName: 'x'`, `timestamps: false`, ... (the entries of `@Table`). */
  tableOptions: string[];
  /** The entries of the `indexes` option, each rendered as lines indented by one level. */
  indexLines: string[];
  associations: V7Association[];
  /** True when the model has no key and Sequelize must not add an `id`. */
  noPrimaryKey: boolean;
  /** True when a default needs `sql.literal`. */
  usesSql: boolean;
}

/** The attribute options that have a decorator, in the order the decorators are written. */
const ENTRY_DECORATORS: readonly {
  pattern: RegExp;
  write: (match: RegExpExecArray) => string;
}[] = [
  { pattern: /^primaryKey: true$/, write: () => '@PrimaryKey' },
  { pattern: /^autoIncrement: true$/, write: () => '@AutoIncrement' },
  { pattern: /^allowNull: false$/, write: () => '@NotNull' },
  { pattern: /^unique: true$/, write: () => '@Unique' },
  {
    pattern: /^unique: (['"].*['"])$/,
    write: (match: RegExpExecArray) => `@Unique(${match[1] ?? ''})`,
  },
  {
    pattern: /^defaultValue: (.+)$/s,
    write: (match: RegExpExecArray) => `@Default(${match[1] ?? ''})`,
  },
  {
    pattern: /^field: (['"].*['"])$/,
    write: (match: RegExpExecArray) => `@ColumnName(${match[1] ?? ''})`,
  },
];

function decoratorsOf(attribute: V7Attribute): {
  decorators: string[];
  leftovers: string[];
} {
  const decorators: string[] = [];
  const taken: Set<number> = new Set<number>();
  for (const candidate of ENTRY_DECORATORS) {
    attribute.entries.forEach((entry: string, at: number): void => {
      const match: RegExpExecArray | null = candidate.pattern.exec(entry);
      if (match !== null && !taken.has(at)) {
        decorators.push(candidate.write(match));
        taken.add(at);
      }
    });
  }
  return {
    decorators,
    leftovers: attribute.entries.filter(
      (_entry: string, at: number) => !taken.has(at)
    ),
  };
}

function propertyType(attribute: V7Attribute): string {
  const base: string = attribute.nullable
    ? `${attribute.ts} | null`
    : attribute.ts;
  return attribute.optional ? `CreationOptional<${base}>` : base;
}

function attributeLines(attribute: V7Attribute): string[] {
  const lines: string[] = [];
  if (attribute.timestamp !== undefined) {
    lines.push(
      `${INDENT}@${attribute.timestamp === 'created' ? 'CreatedAt' : 'UpdatedAt'}`
    );
  } else {
    const { decorators, leftovers } = decoratorsOf(attribute);
    lines.push(
      ...(leftovers.length === 0
        ? [`${INDENT}@Attribute(${attribute.type})`]
        : objectLines(
            '@Attribute(',
            [`type: ${attribute.type}`, ...leftovers],
            INDENT,
            ')'
          )),
      ...decorators.map((decorator: string) => `${INDENT}${decorator}`)
    );
  }
  lines.push(
    `${INDENT}declare ${attribute.isReadonly ? 'readonly ' : ''}${attribute.name}: ${propertyType(attribute)};`
  );
  return lines;
}

function associationLines(association: V7Association): string[] {
  const type: string = `NonAttribute<${association.target}${association.many ? '[]' : ''}>`;
  const declaration: string = `${INDENT}declare ${association.alias}?: ${type};`;
  if (association.decorator === undefined) {
    return [declaration];
  }
  const head: string = `() => ${association.target}`;
  const inline: string = `${INDENT}@${association.decorator}(${head}, { ${association.options.join(', ')} })`;
  if (inline.length <= MAX_LINE_WIDTH) {
    return [inline, declaration];
  }
  return [
    `${INDENT}@${association.decorator}(${head}, {`,
    ...association.options.map(
      (entry: string) => `${INDENT}${INDENT}${entry},`
    ),
    `${INDENT}})`,
    declaration,
  ];
}

function tableLines(model: V7Model): string[] {
  const entries: string[] = [
    ...model.tableOptions,
    ...(model.noPrimaryKey ? ['noPrimaryKey: true'] : []),
  ];
  if (model.indexLines.length === 0) {
    return objectLines('@Table(', entries, '', ')');
  }
  return [
    '@Table({',
    ...entries.map((entry: string) => `${INDENT}${entry},`),
    `${INDENT}indexes: [`,
    ...model.indexLines.map((line: string) => `${INDENT}${line}`),
    `${INDENT}],`,
    '})',
  ];
}

function classHeader(name: string): string[] {
  const inline: string = `export class ${name} extends Model<InferAttributes<${name}>, InferCreationAttributes<${name}>> {`;
  if (inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  return [
    `export class ${name} extends Model<`,
    `${INDENT}InferAttributes<${name}>,`,
    `${INDENT}InferCreationAttributes<${name}>`,
    '> {',
  ];
}

/** The text of one model file. `fileOf` gives the import path of another model's file. */
export function writeV7ModelFile(
  model: V7Model,
  fileOf: (className: string) => string
): string {
  const own: V7Association[] = model.associations;
  const decorators: Set<string> = new Set<string>(['Table']);
  for (const attribute of model.attributes) {
    if (attribute.timestamp !== undefined) {
      decorators.add(
        attribute.timestamp === 'created' ? 'CreatedAt' : 'UpdatedAt'
      );
      continue;
    }
    decorators.add('Attribute');
    const { decorators: used } = decoratorsOf(attribute);
    for (const decorator of used) {
      decorators.add(decorator.slice(1).split('(')[0] ?? '');
    }
  }
  for (const association of own) {
    if (association.decorator !== undefined) {
      decorators.add(association.decorator);
    }
  }
  const needsCreationOptional: boolean = model.attributes.some(
    (attribute: V7Attribute) => attribute.optional
  );
  const specifiers: string[] = [
    ...compact(['DataTypes', 'Model', model.usesSql ? 'sql' : undefined]),
    ...compact([
      needsCreationOptional ? 'CreationOptional' : undefined,
      'InferAttributes',
      'InferCreationAttributes',
      own.length > 0 ? 'NonAttribute' : undefined,
    ]).map((name: string) => `type ${name}`),
  ];
  const lines: string[] = [
    'import {',
    ...specifiers.map((specifier: string) => `${INDENT}${specifier},`),
    `} from '@sequelize/core';`,
    'import {',
    ...[...decorators]
      .sort((first: string, second: string) => first.localeCompare(second))
      .map((name: string) => `${INDENT}${name},`),
    `} from '@sequelize/core/decorators-legacy';`,
  ];
  // The classes the decorators point at are values (read lazily, so circular imports work); a class that is
  // only the type of a property is a type import.
  const valueTargets: Set<string> = new Set<string>(
    own
      .filter(
        (association: V7Association) => association.decorator !== undefined
      )
      .map((association: V7Association) => association.target)
  );
  const typeTargets: Set<string> = new Set<string>(
    own.map((association: V7Association) => association.target)
  );
  for (const name of [...typeTargets].sort()) {
    if (name === model.className) {
      continue;
    }
    lines.push(
      `import ${valueTargets.has(name) ? '' : 'type '}{ ${name} } from '${fileOf(name)}';`
    );
  }
  lines.push('', ...tableLines(model), ...classHeader(model.className));
  const body: string[][] = [
    ...model.attributes.map(attributeLines),
    ...own.map(associationLines),
  ];
  body.forEach((chunk: string[], at: number) => {
    const previous: string[] | undefined = body[at - 1];
    if (
      at > 0 &&
      (chunk.length > 1 ||
        (previous?.length ?? 0) > 1 ||
        at === model.attributes.length)
    ) {
      lines.push('');
    }
    lines.push(...chunk);
  });
  lines.push('}', '');
  return lines.join('\n');
}

/** How a provider is connected with Sequelize 7: the package that holds the dialect, and its class. */
export interface V7Dialect {
  package: string;
  dialect: string;
  /** The connection options of the example, as source lines. */
  connection: string[];
}

/** The text of the `index` file: the models, and the dialect package that goes with the provider. */
export function writeV7Index(
  classes: { className: string; fileBase: string }[],
  dialect: V7Dialect,
  notes: string[]
): string {
  const names: string = classes.map((item) => item.className).join(', ');
  const lines: string[] = [
    ...classes.map(
      (item) => `import { ${item.className} } from './${item.fileBase}.js';`
    ),
    '',
    `export { ${names} };`,
    '',
    '/**',
    ' * Every model of the schema. Sequelize 7 takes them in its constructor, together with the dialect, which',
    ` * is a class from its own package (npm install @sequelize/core ${dialect.package}):`,
    ' *',
    " *   import { Sequelize } from '@sequelize/core';",
    ` *   import { ${dialect.dialect} } from '${dialect.package}';`,
    " *   import { models } from './models/index.js';",
    ' *',
    ` *   const sequelize = new Sequelize({ dialect: ${dialect.dialect}, ${dialect.connection.join(', ')}, models });`,
    ...notes.map((note: string) => ` * ${note}`),
    ' */',
    `export const models = [${names}];`,
    '',
  ];
  return lines.join('\n');
}
