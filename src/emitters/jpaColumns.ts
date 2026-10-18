import type { IrField } from '../ir.js';
import { defaultOf, isPostgres, type DefaultSpec } from './jpaDefaults.js';
import {
  annotation,
  type AnnotationNode,
  type AnnotationValue,
} from './jpaFormat.js';
import { javaString } from './jpaNames.js';
import {
  scalarOf,
  withNativeFacets,
  type Scalar,
  type ScalarContext,
} from './jpaScalars.js';
import {
  Imports,
  type Attribute,
  type EnumPlan,
  type JpaStyle,
} from './jpaTypes.js';
import type { PrismaProvider } from './prisma.js';

/** Works out how one IR field is written as a Java attribute with its JPA and Hibernate annotations. */

export interface ColumnContext {
  style: JpaStyle;
  provider: PrismaProvider;
  enums: ReadonlyMap<string, EnumPlan>;
  warn: (message: string) => void;
}

export interface KeyRole {
  /** True when the column is part of the primary key. */
  isKey: boolean;
  /** True when it is the only column of the primary key. */
  singleKey: boolean;
}

export interface BuiltColumn {
  attribute: Attribute;
  /** The boxed Java type, which an `@IdClass` repeats. */
  boxedType: string;
  /** True when the column has a database default that Hibernate must not overwrite with null. */
  dynamicInsert: boolean;
}

/** Python expressions of Django generated columns: not SQL, so they cannot be written to the database. */
const PYTHON_EXPRESSION: RegExp = /\b(F|Value|ExpressionWrapper|Func|Cast)\(/;

/** Columns that record when the row was created: Hibernate fills them in, whatever the application set. */
function isCreationColumn(field: IrField): boolean {
  return /^(created(at)?|datecreated|creationdate|creationtime)$/.test(
    field.columnName.replace(/_/g, '').toLowerCase()
  );
}

function isInteger(field: IrField): boolean {
  return (
    (field.type === 'int' || field.type === 'bigInt') &&
    field.arrayDepth === undefined &&
    field.enumName === undefined
  );
}

/** How an array column is written: a Java array on PostgreSQL, JSON elsewhere, large text for Hibernate 5. */
function arrayOf(
  context: ScalarContext,
  label: string,
  field: IrField,
  element: Scalar
): Scalar {
  const { imports } = context;
  const depth: number = field.arrayDepth ?? 1;
  if (depth > 1) {
    context.warn(
      `${label}: Hibernate maps one-dimensional arrays only; the ${depth}-dimensional array was written as a one-dimensional one.`
    );
  }
  if (context.style === 'javax') {
    context.warn(
      `${label}: Hibernate 5 cannot map arrays; the column was written as a String with the column definition ${element.columnDefinition ?? 'text'}[].`
    );
    return {
      boxed: imports.use('java.lang.String'),
      columnDefinition: `${element.columnDefinition ?? sqlNameOf(field)}[]`,
      extra: [],
    };
  }
  if (isPostgres(context.provider)) {
    return {
      boxed: `${element.boxed}[]`,
      extra: element.extra.filter(
        (item: AnnotationNode) => item.name !== 'Lob'
      ),
      ...(element.length === undefined ? {} : { length: element.length }),
      ...(element.precision === undefined
        ? {}
        : { precision: element.precision }),
    };
  }
  context.warn(
    `${label}: ${context.provider} has no array type; the column was written as a JSON array.`
  );
  imports.use('java.util.List');
  return {
    boxed: `List<${element.boxed}>`,
    extra: [
      annotation(imports.hibernate('JdbcTypeCode'), [
        [undefined, `${imports.use('org.hibernate.type.SqlTypes')}.JSON`],
      ]),
    ],
  };
}

/** The SQL type name of an array element, for a Hibernate 5 column definition. */
function sqlNameOf(field: IrField): string {
  switch (field.type) {
    case 'int':
      return 'integer';
    case 'bigInt':
      return 'bigint';
    case 'float':
      return 'double precision';
    case 'boolean':
      return 'boolean';
    case 'decimal':
      return 'numeric';
    case 'dateTime':
      return 'timestamp';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'uuid':
      return 'uuid';
    case 'string':
      return field.maxLength === undefined
        ? 'text'
        : `varchar(${field.maxLength})`;
    default:
      return 'text';
  }
}

/** The annotations that store an enum, and the Java type. */
function enumScalar(
  context: ScalarContext,
  field: IrField,
  plan: EnumPlan
): Scalar {
  const { imports } = context;
  const extra: AnnotationNode[] = [];
  if (plan.storage === 'converter') {
    extra.push(
      annotation(imports.persistence('Convert'), [
        ['converter', `${plan.converterName}.class`],
      ])
    );
  } else {
    const enumType: string = imports.persistence('EnumType');
    extra.push(
      annotation(imports.persistence('Enumerated'), [
        [
          undefined,
          `${enumType}.${plan.storage === 'ordinal' ? 'ORDINAL' : 'STRING'}`,
        ],
      ])
    );
  }
  const stringStored: boolean = plan.storage !== 'ordinal' && !plan.numeric;
  return {
    boxed: plan.typeName,
    extra,
    ...(stringStored && field.maxLength !== undefined
      ? { length: field.maxLength }
      : {}),
  };
}

function columnArguments(
  field: IrField,
  scalar: Scalar,
  nullable: boolean,
  role: KeyRole,
  readOnly: boolean
): [string, AnnotationValue][] {
  const args: [string, AnnotationValue][] = [
    ['name', javaString(field.columnName)],
  ];
  if (!nullable && !role.isKey) {
    args.push(['nullable', 'false']);
  }
  if (field.isUnique && !role.isKey && field.uniqueName === undefined) {
    args.push(['unique', 'true']);
  }
  if (scalar.length !== undefined) {
    args.push(['length', String(scalar.length)]);
  }
  if (scalar.precision !== undefined) {
    args.push(['precision', String(scalar.precision.precision)]);
    args.push(['scale', String(scalar.precision.scale)]);
  }
  if (scalar.columnDefinition !== undefined) {
    args.push(['columnDefinition', javaString(scalar.columnDefinition)]);
  }
  if (readOnly) {
    args.push(['insertable', 'false'], ['updatable', 'false']);
  }
  return args;
}

/** The generator annotations of a key column; `undefined` when the key is assigned by the application. */
function keyGenerator(
  context: ColumnContext,
  label: string,
  field: IrField,
  imports: Imports,
  defaults: DefaultSpec
): AnnotationNode[] {
  const generated: string = imports.persistence('GeneratedValue');
  const nodes: AnnotationNode[] = [];
  if (field.default?.kind === 'autoIncrement') {
    if (!isInteger(field)) {
      context.warn(
        `${label}: an auto-increment default on a ${field.type} column cannot be written; the key is assigned by the application.`
      );
      return nodes;
    }
    const strategy: string = imports.persistence('GenerationType');
    nodes.push(annotation(generated, [['strategy', `${strategy}.IDENTITY`]]));
    return nodes;
  }
  if (field.type === 'uuid' && (defaults.uuid === true || defaults.sql)) {
    if (context.style === 'jakarta') {
      const strategy: string = imports.persistence('GenerationType');
      nodes.push(annotation(generated, [['strategy', `${strategy}.UUID`]]));
    } else {
      nodes.push(
        annotation(generated, [['generator', javaString('uuid2')]]),
        annotation(imports.hibernate('GenericGenerator'), [
          ['name', javaString('uuid2')],
          ['strategy', javaString('uuid2')],
        ])
      );
    }
  }
  return nodes;
}

const NOW_TYPES: ReadonlySet<string> = new Set([
  'LocalDateTime',
  'OffsetDateTime',
  'LocalDate',
  'LocalTime',
]);

/**
 * The initializer of a column that has a default: the literal itself, `now()` for a "now" default, and an empty
 * map for the JSON default `{}`. Without one, a property that is NOT NULL would be rejected by Hibernate's
 * nullability check before the database could fill in its default.
 */
function initializerOf(
  context: ColumnContext,
  imports: Imports,
  field: IrField,
  scalar: Scalar,
  defaults: DefaultSpec
): string | undefined {
  if (defaults.initializer !== undefined) {
    for (const name of defaults.initializerImports ?? []) {
      imports.use(name);
    }
    return defaults.initializer;
  }
  if (field.default?.kind === 'now' && NOW_TYPES.has(scalar.boxed)) {
    return `${scalar.boxed}.now()`;
  }
  if (field.type === 'json' && field.default?.kind === 'literal') {
    if (context.style === 'javax') {
      return javaString(String(field.default.value));
    }
    if (String(field.default.value).replace(/\s+/g, '') === '{}') {
      imports.use('java.util.HashMap');
      return 'new HashMap<>()';
    }
  }
  return undefined;
}

/** Builds the Java attribute of an IR field. `name` is the attribute name chosen for it. */
export function buildColumn(
  context: ColumnContext,
  label: string,
  source: IrField,
  name: string,
  role: KeyRole
): BuiltColumn {
  const field: IrField = withNativeFacets(source);
  const imports: Imports = new Imports(context.style);
  const scalarContext: ScalarContext = {
    style: context.style,
    provider: context.provider,
    imports,
    warn: context.warn,
  };
  const plan: EnumPlan | undefined =
    field.enumName === undefined
      ? undefined
      : context.enums.get(field.enumName);
  if (field.enumName !== undefined && plan === undefined) {
    context.warn(
      `${label}: the enum "${field.enumName}" does not exist; the column was written as its stored type.`
    );
  }
  const depth: number = field.arrayDepth ?? 0;
  let scalar: Scalar;
  if (plan !== undefined && depth === 0) {
    scalar = enumScalar(scalarContext, field, plan);
  } else {
    if (plan !== undefined) {
      context.warn(
        `${label}: an array of the enum ${plan.typeName} is stored as an array of its stored values, not as an enum.`
      );
    }
    const elementField: IrField = { ...field };
    delete elementField.arrayDepth;
    const element: Scalar = scalarOf(scalarContext, label, elementField);
    scalar =
      depth > 0 ? arrayOf(scalarContext, label, field, element) : element;
  }

  // Generated (computed) column ----------------------------------------------------------------
  let generatedSql: string | undefined;
  if (field.generated !== undefined) {
    if (PYTHON_EXPRESSION.test(field.generated.expression)) {
      context.warn(
        `${label}: the generated column expression ${field.generated.expression} is Python, not SQL; the column was written as a regular column.`
      );
    } else if (context.style === 'javax') {
      context.warn(
        `${label}: Hibernate 5 has no generated column mapping; the column was written as a regular column.`
      );
    } else {
      generatedSql = field.generated.expression;
    }
  }

  // Defaults ---------------------------------------------------------------------------------
  const defaults: DefaultSpec =
    generatedSql !== undefined
      ? {}
      : defaultOf(
          { provider: context.provider, warn: context.warn },
          label,
          field,
          plan
        );
  const singleKey: boolean = role.isKey && role.singleKey;
  let sqlDefault: string | undefined = defaults.sql;
  let uuidGenerator: boolean = false;
  const generators: AnnotationNode[] = singleKey
    ? keyGenerator(context, label, field, imports, defaults)
    : [];
  if (role.isKey && !role.singleKey && field.default !== undefined) {
    if (field.default.kind === 'autoIncrement' || defaults.uuid === true) {
      context.warn(
        `${label}: JPA cannot generate one column of a composite key; the value is assigned by the application.`
      );
    }
  }
  if (!role.isKey && field.default?.kind === 'autoIncrement') {
    context.warn(
      `${label}: JPA generates identifiers only, so an auto-increment column that is not the key is a plain column; the database fills it only if it is created with an identity by hand.`
    );
  }
  if (defaults.uuid === true && !role.isKey) {
    if (context.style === 'jakarta') {
      generators.push(annotation(imports.hibernate('UuidGenerator')));
      uuidGenerator = true;
    } else if (isPostgres(context.provider)) {
      sqlDefault = 'gen_random_uuid()';
      context.warn(
        `${label}: Hibernate 5 generates identifiers only; the UUID is generated by the database (gen_random_uuid()).`
      );
    } else {
      context.warn(
        `${label}: Hibernate 5 generates identifiers only, so the UUID default was dropped and the application must set the value.`
      );
    }
  }
  const keyGenerated: boolean = generators.length > 0 && singleKey;

  // Timestamps ---------------------------------------------------------------------------------
  const timestamps: AnnotationNode[] = [];
  if (
    defaults.creationTimestamp === true &&
    isCreationColumn(field) &&
    !role.isKey &&
    generatedSql === undefined
  ) {
    timestamps.push(annotation(imports.hibernate('CreationTimestamp')));
  }
  if (field.isAutoUpdated) {
    if (field.type === 'dateTime' && depth === 0 && !role.isKey) {
      timestamps.push(annotation(imports.hibernate('UpdateTimestamp')));
    } else {
      context.warn(
        `${label}: Hibernate can refresh a date-time column only; the ${field.type} column was written as an ordinary column.`
      );
    }
  }

  // Initializer: a new object already shows the default, and Hibernate has a value to insert -----
  const initializer: string | undefined =
    generatedSql === undefined &&
    depth === 0 &&
    !role.isKey &&
    !uuidGenerator &&
    !timestamps.some(
      (item: AnnotationNode) => item.name === 'CreationTimestamp'
    )
      ? initializerOf(context, imports, field, scalar, defaults)
      : undefined;

  // Types ----------------------------------------------------------------------------------------
  const nullable: boolean = role.isKey ? false : field.isNullable;
  const hasDatabaseDefault: boolean =
    sqlDefault !== undefined &&
    initializer === undefined &&
    !timestamps.some(
      (item: AnnotationNode) => item.name === 'CreationTimestamp'
    );
  const usePrimitive: boolean =
    scalar.primitive !== undefined &&
    !nullable &&
    !role.isKey &&
    depth === 0 &&
    plan === undefined &&
    !hasDatabaseDefault &&
    !uuidGenerator &&
    generatedSql === undefined &&
    timestamps.length === 0;
  const type: string = usePrimitive
    ? (scalar.primitive ?? scalar.boxed)
    : scalar.boxed;
  const annotations: AnnotationNode[] = [];
  if (role.isKey) {
    annotations.push(annotation(imports.persistence('Id')));
  }
  annotations.push(...generators, ...scalar.extra);
  annotations.push(
    annotation(
      imports.persistence('Column'),
      columnArguments(field, scalar, nullable, role, generatedSql !== undefined)
    )
  );
  if (sqlDefault !== undefined && generatedSql === undefined) {
    annotations.push(
      annotation(imports.hibernate('ColumnDefault'), [
        [undefined, javaString(sqlDefault)],
      ])
    );
  }
  annotations.push(...timestamps);
  if (generatedSql !== undefined) {
    annotations.push(
      annotation(imports.hibernate('GeneratedColumn'), [
        [undefined, javaString(generatedSql)],
      ])
    );
  }
  const attribute: Attribute = {
    name,
    type,
    annotations,
    imports,
    ...(initializer === undefined ? {} : { initializer }),
    ...(type === 'boolean' ? { isPrimitiveBoolean: true } : {}),
  };
  return {
    attribute,
    boxedType: scalar.boxed,
    dynamicInsert: hasDatabaseDefault && !keyGenerated,
  };
}
