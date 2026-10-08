import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { emitGraphene } from '../src/emitters/graphene.js';
import type { EmitOutput } from '../src/emitters/prisma.js';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { convertCanonical } from './harness.js';

function field(name: string, overrides: Partial<IrField> = {}): IrField {
  return {
    name,
    columnName: name,
    type: 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    ...overrides,
  };
}

function idField(): IrField {
  return field('id', {
    type: 'int',
    isPrimaryKey: true,
    default: { kind: 'autoIncrement' },
  });
}

function relation(
  name: string,
  targetModel: string,
  overrides: Partial<IrRelation> = {}
): IrRelation {
  return {
    name,
    kind: 'foreignKey',
    targetModel,
    columnName: `${name}_id`,
    isNullable: false,
    onDelete: 'cascade',
    ...overrides,
  };
}

function model(name: string, overrides: Partial<IrModel> = {}): IrModel {
  return {
    name,
    tableName: name.toLowerCase(),
    appLabel: 'app',
    fields: [idField(), field('name')],
    relations: [],
    indexes: [],
    ...overrides,
  };
}

function schemaOf(models: IrModel[], enums: IrSchema['enums'] = []): IrSchema {
  return { models, enums, warnings: [] };
}

function emit(schema: IrSchema): EmitOutput {
  return emitGraphene(schema);
}

describe('graphene emitter: structure', () => {
  it('writes imports, one object type per model and the final schema', () => {
    const output: EmitOutput = emit(schemaOf([model('Post'), model('Author')]));
    expect(output.text).toContain('import graphene\n');
    expect(output.text).toContain(
      'from graphene_django import DjangoObjectType'
    );
    expect(output.text).toContain(
      'from .models import (\n    Author,\n    Post,\n)'
    );
    expect(output.text).toContain('class PostType(DjangoObjectType):');
    expect(output.text).toContain('        model = Post\n');
    expect(output.text).toContain('        name = "Post"\n');
    expect(output.text).toContain('class AuthorType(DjangoObjectType):');
    expect(output.text.trimEnd()).toMatch(
      /schema = graphene\.Schema\(query=Query, mutation=Mutation\)$/
    );
    expect(output.warnings).toEqual([]);
  });

  it('lists the fields explicitly and keeps the declaration order', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Post', {
          fields: [idField(), field('title'), field('body', { type: 'text' })],
        }),
      ])
    );
    expect(output.text).toContain(
      '        fields = (\n            "id",\n            "title",\n            "body",\n        )'
    );
  });

  it('is deterministic', () => {
    const schema: IrSchema = schemaOf([model('B'), model('A')]);
    expect(emit(schema).text).toBe(emit(schema).text);
  });

  it('emits a Query with a single-item field and a list field per model', () => {
    const output: EmitOutput = emit(schemaOf([model('BlogPost')]));
    expect(output.text).toContain(
      '    blog_post = graphene.Field(BlogPostType, id=graphene.ID(required=True))'
    );
    expect(output.text).toContain(
      '    blog_post_list = graphene.List(graphene.NonNull(BlogPostType), required=True)'
    );
    expect(output.text).toContain(
      '    def resolve_blog_post(root, info, id):\n        return BlogPost.objects.filter(pk=id).first()'
    );
    expect(output.text).toContain(
      '    def resolve_blog_post_list(root, info):\n        return BlogPost.objects.all()'
    );
  });

  it('emits create, update and delete mutations registered on Mutation', () => {
    const output: EmitOutput = emit(schemaOf([model('Post')]));
    expect(output.text).toContain(
      'class CreatePostMutation(graphene.Mutation):'
    );
    expect(output.text).toContain(
      'class UpdatePostMutation(graphene.Mutation):'
    );
    expect(output.text).toContain(
      'class DeletePostMutation(graphene.Mutation):'
    );
    expect(output.text).toContain(
      '    create_post = CreatePostMutation.Field()\n    update_post = UpdatePostMutation.Field()\n    delete_post = DeletePostMutation.Field()'
    );
    expect(output.text).toContain('class PostInput(graphene.InputObjectType):');
  });

  it('writes a placeholder Query and no Mutation for an empty schema', () => {
    const output: EmitOutput = emit(schemaOf([]));
    expect(output.text).toContain('ping = graphene.String(');
    expect(output.text).not.toContain('class Mutation');
    expect(output.text).toContain('schema = graphene.Schema(query=Query)');
    expect(output.warnings).toHaveLength(1);
  });
});

describe('graphene emitter: inputs', () => {
  it('maps scalar types and derives required from nullability and defaults', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Item', {
          fields: [
            idField(),
            field('title'),
            field('notes', { type: 'text', isNullable: true }),
            field('count', { type: 'int' }),
            field('big', { type: 'bigInt' }),
            field('ratio', { type: 'float' }),
            field('price', { type: 'decimal' }),
            field('flag', {
              type: 'boolean',
              default: { kind: 'literal', value: false },
            }),
            field('at', { type: 'dateTime' }),
            field('day', { type: 'date' }),
            field('clock', { type: 'time' }),
            field('token', { type: 'uuid' }),
            field('extra', { type: 'json' }),
            field('touched', { type: 'dateTime', isAutoUpdated: true }),
          ],
        }),
      ])
    );
    const input: string = output.text.slice(
      output.text.indexOf('class ItemInput('),
      output.text.indexOf('class ItemUpdateInput(')
    );
    expect(input).toContain('    title = graphene.String(required=True)');
    expect(input).toContain('    notes = graphene.String()');
    expect(input).toContain('    count = graphene.Int(required=True)');
    expect(input).toContain('    big = graphene.BigInt(required=True)');
    expect(input).toContain('    ratio = graphene.Float(required=True)');
    expect(input).toContain('    price = graphene.Decimal(required=True)');
    expect(input).toContain('    flag = graphene.Boolean()');
    expect(input).toContain('    at = graphene.DateTime(required=True)');
    expect(input).toContain('    day = graphene.Date(required=True)');
    expect(input).toContain('    clock = graphene.Time(required=True)');
    expect(input).toContain('    token = graphene.UUID(required=True)');
    expect(input).toContain('    extra = graphene.JSONString(required=True)');
    expect(input).not.toContain('touched');
    expect(input).not.toContain('id =');
  });

  it('makes every update input field optional', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Item', { fields: [idField(), field('title')] })])
    );
    const update: string = output.text.slice(
      output.text.indexOf('class ItemUpdateInput(')
    );
    expect(update).toContain('    title = graphene.String()\n');
  });

  it('takes relations as ID inputs and many-to-many as ID lists', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Tag'),
        model('Author'),
        model('Post', {
          relations: [
            relation('author', 'Author'),
            relation('editor', 'Author', { isNullable: true }),
            relation('tags', 'Tag', { kind: 'manyToMany' }),
          ],
        }),
      ])
    );
    expect(output.text).toContain('    author_id = graphene.ID(required=True)');
    expect(output.text).toContain('    editor_id = graphene.ID()');
    expect(output.text).toContain(
      '    tags_ids = graphene.List(graphene.NonNull(graphene.ID))'
    );
    expect(output.text).toContain(
      '_save_instance(Post(), dict(input), {"tags_ids": "tags"})'
    );
  });

  it('keeps a primary key that is not generated on create only', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Country', {
          fields: [field('code', { isPrimaryKey: true })],
        }),
      ])
    );
    expect(output.text).toContain(
      'class CountryInput(graphene.InputObjectType):\n    code = graphene.String(required=True)'
    );
    expect(output.text).not.toContain('CountryUpdateInput');
    expect(output.text).not.toContain('UpdateCountryMutation');
    expect(output.text).toContain('DeleteCountryMutation');
    expect(output.warnings).toEqual([
      'Country: the model has no updatable fields, so no update mutation was generated.',
    ]);
  });
});

describe('graphene emitter: models without writable fields', () => {
  it('creates without an input object, because GraphQL inputs need a field', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Marker', { fields: [idField()] })])
    );
    expect(output.text).not.toContain('MarkerInput');
    expect(output.text).toContain(
      '    def mutate(cls, root, info):\n        instance = _save_instance(Marker(), {}, {})'
    );
  });
});

describe('graphene emitter: enums, relations and names', () => {
  it('relies on choice conversion for output and takes enum inputs as strings', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Post', {
            fields: [
              idField(),
              field('status', {
                enumName: 'PostStatus',
                default: { kind: 'enumValue', value: 'DRAFT' },
              }),
            ],
          }),
        ],
        [
          {
            name: 'PostStatus',
            values: [{ name: 'DRAFT', dbValue: 'draft' }],
          },
        ]
      )
    );
    expect(output.text).toContain('        convert_choices_to_enum = True');
    expect(output.text).toContain('    status = graphene.String()');
    expect(output.warnings).toEqual([
      'Post.status: the enum PostStatus is accepted as a String in mutation inputs; the model validates the value.',
    ]);
  });

  it('exposes reverse accessors, using the Django defaults without related_name', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Author'),
        model('Post', {
          relations: [
            relation('author', 'Author', { relatedName: 'posts' }),
            relation('reviewer', 'Author', { isNullable: true }),
          ],
        }),
        model('Profile', {
          relations: [relation('owner', 'Author', { kind: 'oneToOne' })],
        }),
      ])
    );
    const author: string = output.text.slice(
      output.text.indexOf('class AuthorType('),
      output.text.indexOf('class PostType(')
    );
    expect(author).toContain('"posts"');
    expect(author).toContain('"post_set"');
    expect(author).toContain('"profile"');
  });

  it('snake_cases camelCase field names like the Django emitter', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Post', {
          fields: [idField(), field('viewCount', { type: 'int' })],
        }),
      ])
    );
    expect(output.text).toContain('"view_count"');
    expect(output.text).toContain(
      '    view_count = graphene.Int(required=True)'
    );
    expect(output.text).not.toContain('viewCount');
  });
});

describe('graphene emitter: warnings', () => {
  it('names the model and field of binary columns and leaves them out', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('File', {
          fields: [idField(), field('payload', { type: 'bytes' })],
        }),
      ])
    );
    expect(output.text).not.toContain('payload');
    expect(output.warnings).toEqual([
      'File.payload: binary fields have no GraphQL scalar and were left out of the type.',
      'File.payload: the bytes type has no GraphQL input scalar and was left out of the mutation inputs.',
      'File: the model has no updatable fields, so no update mutation was generated.',
    ]);
  });

  it('names the model and relation when the target is missing', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Post', { relations: [relation('author', 'Ghost')] })])
    );
    expect(output.text).not.toContain('author');
    expect(output.warnings).toEqual([
      'Post.author: the target model "Ghost" is not in the schema, so the relation was left out of the type.',
    ]);
  });

  it('skips single-item, update and delete for composite primary keys', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Link', {
          fields: [
            field('left', { type: 'int' }),
            field('right', { type: 'int' }),
          ],
          compositePrimaryKey: ['left', 'right'],
        }),
      ])
    );
    expect(output.text).toContain('class CreateLinkMutation');
    expect(output.text).not.toContain('UpdateLinkMutation');
    expect(output.text).not.toContain('DeleteLinkMutation');
    expect(output.text).toContain('link_list = graphene.List');
    expect(output.text).not.toContain('resolve_link(');
    expect(output.warnings[0]).toContain('Link: the composite primary key');
  });

  it('warns when two models produce the same Query field name', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Post'), model('PostList')])
    );
    expect(output.warnings).toEqual([
      'PostList: the Query field "post_list" clashes with another model\'s field and was skipped.',
    ]);
  });
});

describe('graphene emitter: generated Python', () => {
  const hasPython: boolean = spawnSync('python3', ['--version']).status === 0;

  function compiles(source: string): SpawnSyncReturns<string> {
    return spawnSync(
      'python3',
      [
        '-I',
        '-c',
        'import sys; compile(sys.stdin.read(), "schema.py", "exec")',
      ],
      { input: source, encoding: 'utf8' }
    );
  }

  const cases: (readonly [string, 'preserve' | 'normalize'])[] = [];
  for (const from of ['django', 'prisma', 'typeorm']) {
    cases.push([from, 'preserve'], [from, 'normalize']);
  }

  describe.each(cases)('%s -> graphene (%s naming)', (from, naming) => {
    it.skipIf(!hasPython)('is valid Python', async () => {
      const result = await convertCanonical(from, 'graphene', { naming });
      const compiled: SpawnSyncReturns<string> = compiles(result.output);
      expect(compiled.stderr).toBe('');
      expect(compiled.status).toBe(0);
    });
  });

  it.skipIf(!hasPython)('rejects invalid Python (sanity check)', () => {
    expect(compiles('def broken(:\n').status).not.toBe(0);
  });
});
