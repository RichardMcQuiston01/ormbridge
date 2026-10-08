import type {
  IrField,
  IrModel,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import { toSnakeCase } from '../naming.js';
import type { EmitOutput } from './prisma.js';

/**
 * Graphene (graphene-django) emitter.
 *
 * The output is one Python file that pairs with a Django models file: it imports
 * every model from `.models` and never defines them. Design decisions:
 *
 * - Names follow what the Django emitter writes (snake_case fields), so the two
 *   outputs line up when both are generated from the same IR.
 * - Enum-backed fields rely on graphene-django's automatic choice conversion for
 *   output types (`convert_choices_to_enum`), which names the GraphQL enum
 *   `<Model><Field>`. Mutation inputs for those fields use `graphene.String`;
 *   the value is validated by the model's `full_clean()`.
 * - Identifiers are plain `ID` values; Relay global IDs (`Meta.interfaces`) are
 *   not used.
 */

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

const INPUT_TYPES: Readonly<Partial<Record<IrScalarType, string>>> = {
  string: 'graphene.String',
  text: 'graphene.String',
  int: 'graphene.Int',
  bigInt: 'graphene.BigInt',
  float: 'graphene.Float',
  decimal: 'graphene.Decimal',
  boolean: 'graphene.Boolean',
  dateTime: 'graphene.DateTime',
  date: 'graphene.Date',
  time: 'graphene.Time',
  uuid: 'graphene.UUID',
  json: 'graphene.JSONString',
};

const MANY_TO_MANY_INPUT: string =
  'graphene.List(graphene.NonNull(graphene.ID))';

interface InputEntry {
  /** Python argument name (snake_case; graphene exposes it as camelCase). */
  name: string;
  /** Scalar class for a plain input, or the complete expression for a list input. */
  graphType: string;
  isList: boolean;
  /** Required on create; every input is optional on update. */
  isRequired: boolean;
  /** True for primary key columns, which create may set but update never changes. */
  isKey: boolean;
  /** Set for many-to-many entries: the model attribute the ids are assigned to. */
  manyToManyTarget?: string;
}

interface EmitContext {
  warnings: string[];
}

const HELPERS: string = `def _get_instance(model, pk):
    try:
        return model.objects.get(pk=pk)
    except model.DoesNotExist:
        raise GraphQLError(f"{model.__name__} with id {pk} does not exist.") from None


def _save_instance(instance, data, many_to_many):
    for key, value in data.items():
        if key not in many_to_many:
            setattr(instance, key, value)
    # Only validate what the caller supplied: values the model fills in itself
    # (for example an empty JSON default) would otherwise fail the blank check.
    exclude = [
        field.name
        for field in instance._meta.fields
        if field.name not in data and field.attname not in data
    ]
    try:
        instance.full_clean(exclude=exclude)
    except ValidationError as error:
        raise GraphQLError("; ".join(error.messages)) from error
    instance.save()
    for key, name in many_to_many.items():
        if data.get(key) is not None:
            getattr(instance, name).set(data[key])
    return instance`;

/** Writes the IR as a graphene-django schema module. */
export function emitGraphene(schema: IrSchema): EmitOutput {
  const context: EmitContext = { warnings: [] };
  const models: IrModel[] = toDjangoNaming(schema.models);
  const modelNames: ReadonlySet<string> = new Set(
    models.map((model: IrModel) => model.name)
  );
  const reverseNames: Map<string, string[]> = collectReverseNames(
    context,
    models,
    modelNames
  );

  const typeBlocks: string[] = [];
  const inputBlocks: string[] = [];
  const mutationBlocks: string[] = [];
  const queryFields: string[] = [];
  const queryResolvers: string[] = [];
  const mutationFields: string[] = [];
  const usedQueryNames: Set<string> = new Set();

  for (const model of models) {
    typeBlocks.push(
      emitObjectType(context, model, modelNames, reverseNames.get(model.name))
    );
    const entries: InputEntry[] = buildInputEntries(context, model, modelNames);
    const hasSingleKey: boolean = !isCompositeKey(context, model);
    const snake: string = toSnakeCase(model.name) || model.name.toLowerCase();

    // GraphQL input objects need at least one field, so empty inputs are left out.
    const updatable: InputEntry[] = entries.filter(
      (entry: InputEntry) => !entry.isKey
    );
    if (entries.length > 0) {
      inputBlocks.push(emitInput(`${model.name}Input`, entries, true));
    }
    if (updatable.length > 0) {
      inputBlocks.push(emitInput(`${model.name}UpdateInput`, entries, false));
    }

    mutationBlocks.push(emitCreateMutation(model, snake, entries));
    mutationFields.push(
      `    create_${snake} = Create${model.name}Mutation.Field()`
    );
    if (hasSingleKey) {
      if (updatable.length > 0) {
        mutationBlocks.push(emitUpdateMutation(model, snake, entries));
        mutationFields.push(
          `    update_${snake} = Update${model.name}Mutation.Field()`
        );
      } else {
        context.warnings.push(
          `${model.name}: the model has no updatable fields, so no update mutation was generated.`
        );
      }
      mutationBlocks.push(emitDeleteMutation(model));
      mutationFields.push(
        `    delete_${snake} = Delete${model.name}Mutation.Field()`
      );
      addQueryField(
        context,
        usedQueryNames,
        model.name,
        snake,
        `    ${snake} = graphene.Field(${model.name}Type, id=graphene.ID(required=True))`,
        [
          `    def resolve_${snake}(root, info, id):`,
          `        return ${model.name}.objects.filter(pk=id).first()`,
        ],
        queryFields,
        queryResolvers
      );
    }
    const listName: string = `${snake}_list`;
    addQueryField(
      context,
      usedQueryNames,
      model.name,
      listName,
      `    ${listName} = graphene.List(graphene.NonNull(${model.name}Type), required=True)`,
      [
        `    def resolve_${listName}(root, info):`,
        `        return ${model.name}.objects.all()`,
      ],
      queryFields,
      queryResolvers
    );
  }

  const blocks: string[] = [
    HELPERS,
    ...typeBlocks,
    ...inputBlocks,
    ...mutationBlocks,
  ];

  if (queryFields.length === 0) {
    if (models.length === 0) {
      context.warnings.push(
        'The schema contains no models, so the Query type has only a placeholder "ping" field.'
      );
    }
    queryFields.push('    ping = graphene.String(default_value="pong")');
  }
  const queryLines: string[] = ['class Query(graphene.ObjectType):'];
  queryLines.push(...queryFields);
  for (const resolver of queryResolvers) {
    queryLines.push('', resolver);
  }
  blocks.push(queryLines.join('\n'));

  let schemaLine: string = 'schema = graphene.Schema(query=Query)';
  if (mutationFields.length > 0) {
    blocks.push(
      ['class Mutation(graphene.ObjectType):', ...mutationFields].join('\n')
    );
    schemaLine = 'schema = graphene.Schema(query=Query, mutation=Mutation)';
  }
  blocks.push(schemaLine);

  const text: string = `${buildHeader(models)}\n\n\n${blocks.join('\n\n\n')}\n`;
  return { text, warnings: context.warnings };
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function buildHeader(models: IrModel[]): string {
  const lines: string[] = [
    '# Generated by ormbridge. Review the output before use.',
    '# Pairs with a Django models file: the models imported below must be defined in',
    '# the models module next to this file (for example the output of `--to django`).',
    "# Requires graphene-django 3.x. Enum-backed fields use graphene-django's automatic",
    '# choice conversion for output; mutation inputs accept the stored value as a String.',
    'import graphene',
    'from django.core.exceptions import ValidationError',
    'from graphene_django import DjangoObjectType',
    'from graphql import GraphQLError',
  ];
  const names: string[] = models
    .map((model: IrModel) => model.name)
    .sort((first: string, second: string) => first.localeCompare(second));
  if (names.length > 0) {
    lines.push('', 'from .models import (');
    for (const name of names) {
      lines.push(`    ${name},`);
    }
    lines.push(')');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Naming and reverse relations
// ---------------------------------------------------------------------------

/** Renames fields and relations to snake_case, exactly like the Django emitter. */
function toDjangoNaming(models: IrModel[]): IrModel[] {
  return models.map((model: IrModel): IrModel => ({
    ...model,
    fields: model.fields.map((field: IrField): IrField => ({
      ...field,
      name: toSnakeCase(field.name) || field.name,
    })),
    relations: model.relations.map((relation: IrRelation): IrRelation => ({
      ...relation,
      name: toSnakeCase(relation.name) || relation.name,
      ...(relation.relatedName === undefined
        ? {}
        : { relatedName: toSnakeCase(relation.relatedName) }),
    })),
  }));
}

/** The accessor name Django gives the reverse side of a relation. */
function reverseAccessor(model: IrModel, relation: IrRelation): string {
  if (
    relation.relatedName !== undefined &&
    IDENTIFIER_PATTERN.test(relation.relatedName)
  ) {
    return relation.relatedName;
  }
  const lower: string = model.name.toLowerCase();
  return relation.kind === 'oneToOne' ? lower : `${lower}_set`;
}

/** Maps each target model to the reverse accessor names that are listed in its Meta.fields. */
function collectReverseNames(
  context: EmitContext,
  models: IrModel[],
  modelNames: ReadonlySet<string>
): Map<string, string[]> {
  const taken: Map<string, Set<string>> = new Map();
  for (const model of models) {
    taken.set(
      model.name,
      new Set([
        ...model.fields.map((field: IrField) => field.name),
        ...model.relations.map((relation: IrRelation) => relation.name),
      ])
    );
  }
  const result: Map<string, string[]> = new Map();
  for (const model of models) {
    for (const relation of model.relations) {
      const names: Set<string> | undefined = taken.get(relation.targetModel);
      if (!modelNames.has(relation.targetModel) || names === undefined) {
        continue;
      }
      const accessor: string = reverseAccessor(model, relation);
      if (names.has(accessor)) {
        context.warnings.push(
          `${model.name}.${relation.name}: the reverse accessor "${accessor}" clashes with another field on ${relation.targetModel}, so it is not exposed in GraphQL.`
        );
        continue;
      }
      names.add(accessor);
      const list: string[] = result.get(relation.targetModel) ?? [];
      list.push(accessor);
      result.set(relation.targetModel, list);
    }
  }
  return result;
}

function isCompositeKey(context: EmitContext, model: IrModel): boolean {
  const isComposite: boolean =
    model.compositePrimaryKey !== undefined &&
    model.compositePrimaryKey.length > 0;
  if (isComposite) {
    context.warnings.push(
      `${model.name}: the composite primary key has no single id, so only the list query and the create mutation are generated (no single-item query, update or delete).`
    );
  }
  return isComposite;
}

function addQueryField(
  context: EmitContext,
  used: Set<string>,
  modelName: string,
  name: string,
  declaration: string,
  resolver: string[],
  fields: string[],
  resolvers: string[]
): void {
  if (used.has(name)) {
    context.warnings.push(
      `${modelName}: the Query field "${name}" clashes with another model's field and was skipped.`
    );
    return;
  }
  used.add(name);
  fields.push(declaration);
  resolvers.push(resolver.join('\n'));
}

// ---------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------

function emitObjectType(
  context: EmitContext,
  model: IrModel,
  modelNames: ReadonlySet<string>,
  reverse: string[] | undefined
): string {
  const exposed: string[] = [];
  for (const field of model.fields) {
    if (field.type === 'bytes') {
      context.warnings.push(
        `${model.name}.${field.name}: binary fields have no GraphQL scalar and were left out of the type.`
      );
      continue;
    }
    exposed.push(field.name);
  }
  for (const relation of model.relations) {
    if (!modelNames.has(relation.targetModel)) {
      context.warnings.push(
        `${model.name}.${relation.name}: the target model "${relation.targetModel}" is not in the schema, so the relation was left out of the type.`
      );
      continue;
    }
    exposed.push(relation.name);
  }
  exposed.push(...(reverse ?? []));

  const hasEnum: boolean = model.fields.some(
    (field: IrField) => field.enumName !== undefined
  );
  const lines: string[] = [
    `class ${model.name}Type(DjangoObjectType):`,
    '    class Meta:',
    `        model = ${model.name}`,
    `        name = ${pyString(model.name)}`,
  ];
  if (hasEnum) {
    lines.push('        convert_choices_to_enum = True');
  }
  if (exposed.length === 0) {
    lines.push('        fields = ()');
  } else {
    lines.push('        fields = (');
    for (const name of exposed) {
      lines.push(`            ${pyString(name)},`);
    }
    lines.push('        )');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Inputs and mutations
// ---------------------------------------------------------------------------

function isGeneratedKey(field: IrField): boolean {
  const kind: string | undefined = field.default?.kind;
  return field.isPrimaryKey && (kind === 'autoIncrement' || kind === 'uuid');
}

/** Builds the input entries shared by the create and update inputs. */
function buildInputEntries(
  context: EmitContext,
  model: IrModel,
  modelNames: ReadonlySet<string>
): InputEntry[] {
  const entries: InputEntry[] = [];
  for (const field of model.fields) {
    if (isGeneratedKey(field) || field.isAutoUpdated) {
      continue;
    }
    const graphType: string | undefined = INPUT_TYPES[field.type];
    if (graphType === undefined) {
      context.warnings.push(
        `${model.name}.${field.name}: the ${field.type} type has no GraphQL input scalar and was left out of the mutation inputs.`
      );
      continue;
    }
    if (field.enumName !== undefined) {
      context.warnings.push(
        `${model.name}.${field.name}: the enum ${field.enumName} is accepted as a String in mutation inputs; the model validates the value.`
      );
    }
    entries.push({
      name: field.name,
      graphType: field.enumName === undefined ? graphType : 'graphene.String',
      isList: false,
      isKey: field.isPrimaryKey,
      isRequired: !field.isNullable && field.default === undefined,
    });
  }
  for (const relation of model.relations) {
    if (!modelNames.has(relation.targetModel)) {
      continue;
    }
    if (relation.kind === 'manyToMany') {
      entries.push({
        name: `${relation.name}_ids`,
        graphType: MANY_TO_MANY_INPUT,
        isList: true,
        isKey: false,
        isRequired: false,
        manyToManyTarget: relation.name,
      });
    } else {
      entries.push({
        name: `${relation.name}_id`,
        graphType: 'graphene.ID',
        isList: false,
        isKey: relation.isPrimaryKey === true,
        isRequired: !relation.isNullable,
      });
    }
  }
  return entries;
}

function emitInput(
  className: string,
  entries: InputEntry[],
  forCreate: boolean
): string {
  const lines: string[] = [`class ${className}(graphene.InputObjectType):`];
  const visible: InputEntry[] = entries.filter(
    (entry: InputEntry) => forCreate || !entry.isKey
  );
  if (visible.length === 0) {
    lines.push('    pass');
  }
  for (const entry of visible) {
    const required: string =
      forCreate && entry.isRequired ? 'required=True' : '';
    const call: string = entry.isList
      ? entry.graphType
      : `${entry.graphType}(${required})`;
    lines.push(`    ${entry.name} = ${call}`);
  }
  return lines.join('\n');
}

function manyToManyLiteral(entries: InputEntry[]): string {
  const pairs: string[] = entries
    .filter((entry: InputEntry) => entry.manyToManyTarget !== undefined)
    .map(
      (entry: InputEntry) =>
        `${pyString(entry.name)}: ${pyString(entry.manyToManyTarget ?? '')}`
    );
  return `{${pairs.join(', ')}}`;
}

function emitCreateMutation(
  model: IrModel,
  snake: string,
  entries: InputEntry[]
): string {
  const hasInput: boolean = entries.length > 0;
  return [
    `class Create${model.name}Mutation(graphene.Mutation):`,
    ...(hasInput
      ? [
          '    class Arguments:',
          `        input = ${model.name}Input(required=True)`,
        ]
      : []),
    ...(hasInput ? [''] : []),
    `    ${snake} = graphene.Field(${model.name}Type)`,
    '',
    '    @classmethod',
    `    def mutate(cls, root, info${hasInput ? ', input' : ''}):`,
    `        instance = _save_instance(${model.name}(), ${hasInput ? 'dict(input)' : '{}'}, ${manyToManyLiteral(entries)})`,
    `        return cls(${snake}=instance)`,
  ].join('\n');
}

function emitUpdateMutation(
  model: IrModel,
  snake: string,
  entries: InputEntry[]
): string {
  return [
    `class Update${model.name}Mutation(graphene.Mutation):`,
    '    class Arguments:',
    '        id = graphene.ID(required=True)',
    `        input = ${model.name}UpdateInput(required=True)`,
    '',
    `    ${snake} = graphene.Field(${model.name}Type)`,
    '',
    '    @classmethod',
    '    def mutate(cls, root, info, id, input):',
    `        instance = _save_instance(_get_instance(${model.name}, id), dict(input), ${manyToManyLiteral(entries)})`,
    `        return cls(${snake}=instance)`,
  ].join('\n');
}

function emitDeleteMutation(model: IrModel): string {
  return [
    `class Delete${model.name}Mutation(graphene.Mutation):`,
    '    class Arguments:',
    '        id = graphene.ID(required=True)',
    '',
    '    ok = graphene.Boolean(required=True)',
    '',
    '    @classmethod',
    '    def mutate(cls, root, info, id):',
    `        _get_instance(${model.name}, id).delete()`,
    '        return cls(ok=True)',
  ].join('\n');
}
