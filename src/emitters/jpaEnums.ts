import type { IrEnumValue, IrField, IrSchema } from '../ir.js';
import { formatAnnotation, annotation } from './jpaFormat.js';
import {
  classNameOf,
  javaString,
  repairedIdentifier,
  RESERVED_TYPE_NAMES,
  uniqueName,
} from './jpaNames.js';
import { Imports, type EnumPlan, type JpaStyle } from './jpaTypes.js';

/** Plans and writes the Java enums of the IR enums, and the converters of those whose stored values differ. */

/** True when a column stores numbers (an enum in it is an ordinal or a converted integer). */
function isNumericColumn(field: IrField): boolean {
  return (
    (field.type === 'int' || field.type === 'bigInt') &&
    field.arrayDepth === undefined
  );
}

/** Plans every enum of the schema; `typeNames` holds the class names taken so far and receives the new ones. */
export function planEnums(
  schema: IrSchema,
  typeNames: Set<string>,
  warn: (message: string) => void
): Map<string, EnumPlan> {
  const columns: Map<string, IrField[]> = new Map<string, IrField[]>();
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.enumName !== undefined) {
        columns.set(field.enumName, [
          ...(columns.get(field.enumName) ?? []),
          field,
        ]);
      }
    }
  }
  const plans: Map<string, EnumPlan> = new Map<string, EnumPlan>();
  for (const enumeration of schema.enums) {
    const raw: string = classNameOf(enumeration.name);
    const typeName: string = uniqueName(
      RESERVED_TYPE_NAMES.has(raw) ? `${raw}Enum` : raw,
      typeNames
    );
    if (typeName !== raw) {
      warn(
        `enum ${enumeration.name}: "${raw}" is a name the generated code uses or another type has, so the enum was named "${typeName}".`
      );
    }
    const used: Set<string> = new Set<string>();
    const members: Map<string, string> = new Map<string, string>();
    for (const value of enumeration.values) {
      const name: string = uniqueName(repairedIdentifier(value.name), used);
      if (name !== value.name) {
        warn(
          `enum ${enumeration.name}: the member "${value.name}" was written as "${name}".`
        );
      }
      members.set(value.name, name);
    }
    const users: IrField[] = columns.get(enumeration.name) ?? [];
    const numeric: boolean =
      users.length > 0 &&
      users.every(isNumericColumn) &&
      enumeration.values.every((value: IrEnumValue) =>
        /^-?\d+$/.test(value.dbValue)
      );
    const namesMatch: boolean = enumeration.values.every(
      (value: IrEnumValue) => members.get(value.name) === value.dbValue
    );
    const isOrdinal: boolean =
      numeric &&
      enumeration.values.every(
        (value: IrEnumValue, index: number) => value.dbValue === String(index)
      );
    let storage: EnumPlan['storage'] = 'converter';
    if (users.length === 0 || (!numeric && namesMatch)) {
      storage = 'names';
    } else if (isOrdinal) {
      storage = 'ordinal';
    }
    plans.set(enumeration.name, {
      enumeration,
      typeName,
      members,
      storage,
      numeric,
      converterName:
        storage === 'converter'
          ? uniqueName(`${typeName}Converter`, typeNames)
          : '',
    });
  }
  return plans;
}

function constantLines(plan: EnumPlan): string[] {
  const values: IrEnumValue[] = plan.enumeration.values;
  if (plan.storage !== 'converter') {
    return values.map(
      (value: IrEnumValue, index: number) =>
        `  ${plan.members.get(value.name) ?? value.name}${index === values.length - 1 ? '' : ','}`
    );
  }
  return values.map((value: IrEnumValue, index: number) => {
    const stored: string = plan.numeric
      ? value.dbValue
      : javaString(value.dbValue);
    return `  ${plan.members.get(value.name) ?? value.name}(${stored})${index === values.length - 1 ? ';' : ','}`;
  });
}

/** The text of a Java enum file (without the header and package, which the caller writes). */
export function renderEnumBody(plan: EnumPlan): string[] {
  const lines: string[] = [`public enum ${plan.typeName} {`];
  if (plan.storage !== 'converter') {
    lines.push(...constantLines(plan));
    if (plan.enumeration.values.length > 0) {
      lines.push('}');
    } else {
      lines.splice(1, 0, '  ;');
      lines.push('}');
    }
    return lines;
  }
  const type: string = plan.numeric ? 'int' : 'String';
  lines.push(...constantLines(plan));
  if (plan.enumeration.values.length === 0) {
    lines.push('  ;');
  }
  lines.push(
    '',
    `  private final ${type} value;`,
    '',
    `  ${plan.typeName}(${type} value) {`,
    '    this.value = value;',
    '  }',
    '',
    `  public ${type} getValue() {`,
    '    return value;',
    '  }',
    '}'
  );
  return lines;
}

/** The body of the converter file of an enum whose stored values differ from the constant names. */
export function renderConverterBody(
  plan: EnumPlan,
  style: JpaStyle
): { imports: Imports; lines: string[] } {
  const imports: Imports = new Imports(style);
  const converter: string = imports.persistence('Converter');
  const base: string = imports.persistence('AttributeConverter');
  const stored: string = plan.numeric ? 'Integer' : 'String';
  const type: string = plan.typeName;
  const compare: string = plan.numeric
    ? 'item.getValue() == dbData'
    : 'item.getValue().equals(dbData)';
  const lines: string[] = [
    ...formatAnnotation(annotation(converter), 0),
    `public class ${plan.converterName} implements ${base}<${type}, ${stored}> {`,
    '  @Override',
    `  public ${stored} convertToDatabaseColumn(${type} attribute) {`,
    '    return attribute == null ? null : attribute.getValue();',
    '  }',
    '',
    '  @Override',
    `  public ${type} convertToEntityAttribute(${stored} dbData) {`,
    '    if (dbData == null) {',
    '      return null;',
    '    }',
    `    for (${type} item : ${type}.values()) {`,
    `      if (${compare}) {`,
    '        return item;',
    '      }',
    '    }',
    `    throw new IllegalArgumentException("Unknown ${type} value: " + dbData);`,
    '  }',
    '}',
  ];
  return { imports, lines };
}
