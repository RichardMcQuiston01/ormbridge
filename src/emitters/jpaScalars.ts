import type { IrField, IrRangeSubtype } from '../ir.js';
import { isPostgres } from './jpaDefaults.js';
import { annotation, type AnnotationNode } from './jpaFormat.js';
import type { Imports, JpaStyle } from './jpaTypes.js';
import type { PrismaProvider } from './prisma.js';

/** The Java type, the extra annotations and the column facets of one IR scalar type. */
export interface Scalar {
  /** The boxed Java type (`Integer`, `String`, `Map<String, Object>`). */
  boxed: string;
  /** The primitive Java type, for a column that cannot be null. */
  primitive?: string;
  /** `@Column(length)` for a string. */
  length?: number;
  /** `@Column(precision, scale)` for a decimal. */
  precision?: { precision: number; scale: number };
  /** `@Column(columnDefinition)`, for a type the Java type does not say. */
  columnDefinition?: string;
  /** Annotations that go with the type (`@Lob`, `@JdbcTypeCode`). */
  extra: AnnotationNode[];
}

export interface ScalarContext {
  style: JpaStyle;
  provider: PrismaProvider;
  imports: Imports;
  warn: (message: string) => void;
}

const RANGE_TYPES: Readonly<Record<IrRangeSubtype, string>> = {
  int: 'int4range',
  bigInt: 'int8range',
  decimal: 'numrange',
  date: 'daterange',
  dateTime: 'tsrange',
};

/** The facets that a Prisma `@db.*` native type adds to a field the type alone leaves open. */
export function withNativeFacets(field: IrField): IrField {
  const native: IrField['nativeType'] = field.nativeType;
  if (native === undefined) {
    return field;
  }
  const name: string = native.name.toLowerCase();
  const first: number = Number(native.args[0]);
  const second: number = Number(native.args[1] ?? 0);
  if (
    (name === 'varchar' || name === 'char') &&
    field.type === 'string' &&
    field.maxLength === undefined &&
    Number.isInteger(first)
  ) {
    return { ...field, maxLength: first };
  }
  if (
    (name === 'decimal' || name === 'numeric') &&
    field.type === 'decimal' &&
    field.maxDigits === undefined &&
    Number.isInteger(first)
  ) {
    return {
      ...field,
      maxDigits: first,
      decimalPlaces: Number.isInteger(second) ? second : 0,
    };
  }
  return field;
}

/** True when the column keeps a time zone, judging by the native type Prisma gave it. */
function hasTimeZone(field: IrField): boolean {
  return /timestamptz|datetimeoffset|with time zone/i.test(
    field.nativeType?.name ?? ''
  );
}

/** A large text column: a `text` column on PostgreSQL, `@Lob` elsewhere. */
function largeText(context: ScalarContext): Scalar {
  const boxed: string = context.imports.use('java.lang.String');
  if (isPostgres(context.provider)) {
    return { boxed, columnDefinition: 'text', extra: [] };
  }
  return {
    boxed,
    extra: [annotation(context.imports.persistence('Lob'))],
  };
}

/** A JSON column: Hibernate 6 maps it itself, Hibernate 5 has no JSON type. */
function jsonColumn(context: ScalarContext, label: string): Scalar {
  const { imports } = context;
  if (context.style === 'jakarta') {
    imports.use('java.util.Map');
    return {
      boxed: 'Map<String, Object>',
      extra: [
        annotation(imports.hibernate('JdbcTypeCode'), [
          [undefined, `${imports.use('org.hibernate.type.SqlTypes')}.JSON`],
        ]),
      ],
    };
  }
  const definition: string | undefined = isPostgres(context.provider)
    ? 'jsonb'
    : context.provider === 'mysql'
      ? 'json'
      : undefined;
  context.warn(
    `${label}: Hibernate 5 has no JSON type; the column was written as a String${definition === undefined ? ' of large text' : ` with the column definition ${definition}`}, and the JSON text is yours to read and write (the hibernate-types library adds a mapping).`
  );
  return definition === undefined
    ? largeText(context)
    : {
        boxed: imports.use('java.lang.String'),
        columnDefinition: definition,
        extra: [],
      };
}

function stringWith(
  context: ScalarContext,
  columnDefinition: string | undefined
): Scalar {
  return {
    boxed: context.imports.use('java.lang.String'),
    ...(columnDefinition === undefined ? {} : { columnDefinition }),
    extra: [],
  };
}

/** Maps one scalar IR field (arrays are handled by the caller) to a Java type. */
export function scalarOf(
  context: ScalarContext,
  label: string,
  field: IrField
): Scalar {
  const { imports } = context;
  const postgres: boolean = isPostgres(context.provider);
  switch (field.type) {
    case 'string':
      if (field.maxLength === undefined) {
        if (postgres) {
          return largeText(context);
        }
        // Large text columns cannot be keys, unique or indexed outside PostgreSQL; a string is meant to be.
        context.warn(
          `${label}: a string without a length was written with the JPA default length of 255, because ${context.provider} cannot index a large text column.`
        );
        return { ...stringWith(context, undefined), length: 255 };
      }
      return { ...stringWith(context, undefined), length: field.maxLength };
    case 'text':
      return largeText(context);
    case 'int':
      return { boxed: 'Integer', primitive: 'int', extra: [] };
    case 'bigInt':
      return { boxed: 'Long', primitive: 'long', extra: [] };
    case 'float':
      return { boxed: 'Double', primitive: 'double', extra: [] };
    case 'boolean':
      return { boxed: 'Boolean', primitive: 'boolean', extra: [] };
    case 'decimal': {
      const digits: number | undefined =
        field.maxDigits ?? (field.decimalPlaces === undefined ? undefined : 38);
      return {
        boxed: imports.use('java.math.BigDecimal'),
        extra: [],
        ...(digits === undefined
          ? {}
          : {
              precision: {
                precision: digits,
                scale: field.decimalPlaces ?? 0,
              },
            }),
      };
    }
    case 'dateTime':
      return {
        boxed: imports.use(
          hasTimeZone(field)
            ? 'java.time.OffsetDateTime'
            : 'java.time.LocalDateTime'
        ),
        extra: [],
      };
    case 'date':
      return { boxed: imports.use('java.time.LocalDate'), extra: [] };
    case 'time':
      return { boxed: imports.use('java.time.LocalTime'), extra: [] };
    case 'duration':
      return { boxed: imports.use('java.time.Duration'), extra: [] };
    case 'uuid':
      return { boxed: imports.use('java.util.UUID'), extra: [] };
    case 'bytes':
      return postgres
        ? { boxed: 'byte[]', extra: [] }
        : {
            boxed: 'byte[]',
            extra: [annotation(imports.persistence('Lob'))],
          };
    case 'json':
      return jsonColumn(context, label);
    case 'ipAddress':
      if (postgres && context.style === 'jakarta') {
        return {
          boxed: imports.use('java.net.InetAddress'),
          extra: [
            annotation(imports.hibernate('JdbcTypeCode'), [
              [undefined, `${imports.use('org.hibernate.type.SqlTypes')}.INET`],
            ]),
          ],
        };
      }
      if (postgres) {
        context.warn(
          `${label}: Hibernate 5 has no inet mapping; the column was written as a String with the column definition inet.`
        );
        return stringWith(context, 'inet');
      }
      context.warn(
        `${label}: only PostgreSQL has an inet type; the column was written as a string of at most 45 characters.`
      );
      return { ...stringWith(context, undefined), length: 45 };
    case 'hstore':
      context.warn(
        postgres
          ? `${label}: Hibernate has no hstore mapping; the column was written as a String with the column definition hstore.`
          : `${label}: hstore is a PostgreSQL type; the column was written as large text.`
      );
      return postgres ? stringWith(context, 'hstore') : largeText(context);
    case 'range': {
      const range: string | undefined =
        field.rangeOf === undefined ? undefined : RANGE_TYPES[field.rangeOf];
      if (postgres && range !== undefined) {
        context.warn(
          `${label}: Hibernate has no range mapping; the column was written as a String with the column definition ${range}.`
        );
        return stringWith(context, range);
      }
      context.warn(
        `${label}: range types exist only in PostgreSQL; the column was written as large text.`
      );
      return largeText(context);
    }
    case 'unsupported':
    default:
      context.warn(
        `${label}: the database type "${field.unsupportedType ?? 'unknown'}" has no Java mapping; the column was written as a String${field.unsupportedType === undefined ? '' : ` with the column definition ${field.unsupportedType}`}.`
      );
      return stringWith(context, field.unsupportedType);
  }
}
