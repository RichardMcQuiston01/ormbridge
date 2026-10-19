import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { emitNeo4j } from '../src/emitters/neo4j.js';
import {
  labelOf,
  oneLine,
  quoteIdentifier,
  relationshipTypeOf,
} from '../src/emitters/neo4jNames.js';
import { mapFieldType } from '../src/emitters/neo4jTypes.js';
import { getFormat } from '../src/formats.js';
import type { IrModel, IrSchema } from '../src/ir.js';
import { checkStyle } from '../src/styles.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import {
  field,
  idField,
  index,
  model,
  relation,
  schemaOf,
} from './gormFixtures.js';
import { checkNeo4jOutput } from './neo4jCoverage.js';
import { joinsSchema, keysSchema, typesModel } from './neo4jFixtures.js';
import { splitCypher } from './neo4jSupport.js';

function emit(
  schema: IrSchema,
  options: Partial<Parameters<typeof emitNeo4j>[1]> = {}
): { text: string; warnings: string[] } {
  const output = emitNeo4j(schema, { camelFields: false, ...options });
  return { text: output.text, warnings: output.warnings };
}

async function convertCanonicalPrisma(
  overrides: Partial<Parameters<typeof convertText>[1]> = {}
): Promise<ConvertResult> {
  return expectOk(
    await convertText(loadCanonicalSources('prisma'), {
      ...DEFAULT_OPTIONS,
      from: 'prisma',
      to: 'neo4j',
      ...overrides,
    })
  );
}

describe('the neo4j format', () => {
  it('is registered as write only and claims no file extension', () => {
    const adapter = expectOk(getFormat('neo4j'));
    expect(adapter.parse).toBeUndefined();
    expect(adapter.emit).toBeDefined();
    expect(adapter.extensions).toEqual([]);
  });

  it('cannot be used as an input', async () => {
    const result = await convertText(loadCanonicalSources('prisma'), {
      ...DEFAULT_OPTIONS,
      from: 'neo4j',
      to: 'prisma',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_CONVERSION');
      expect(result.error.message).toContain('can only be used as an output');
    }
  });

  it('writes one statement per line, each ending in a semicolon', async () => {
    const { output } = await convertCanonicalPrisma();
    const lines: string[] = output
      .split('\n')
      .filter((line: string) => line !== '' && !line.startsWith('//'));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line).toMatch(/^CREATE (?:CONSTRAINT|INDEX|FULLTEXT INDEX) .*;$/);
      expect(line).toContain(' IF NOT EXISTS ');
    }
    expect(splitCypher(output)).toHaveLength(lines.length);
  });

  it('is deterministic', async () => {
    const first: ConvertResult = await convertCanonicalPrisma();
    const second: ConvertResult = await convertCanonicalPrisma();
    expect(second.output).toBe(first.output);
    expect(second.warnings).toEqual(first.warnings);
  });
});

describe('community style (default)', () => {
  it('writes uniqueness constraints for keys, unique columns and unique indexes, and range indexes', async () => {
    const { output } = await convertCanonicalPrisma();
    const statements: string[] = splitCypher(output);
    expect(statements).toContain(
      'CREATE CONSTRAINT post_id_unique IF NOT EXISTS FOR (n:Post) REQUIRE n.id IS UNIQUE'
    );
    expect(statements).toContain(
      'CREATE CONSTRAINT post_public_id_unique IF NOT EXISTS FOR (n:Post) REQUIRE n.public_id IS UNIQUE'
    );
    expect(statements).toContain(
      'CREATE CONSTRAINT post_author_id_title_unique IF NOT EXISTS FOR (n:Post) REQUIRE (n.author_id, n.title) IS UNIQUE'
    );
    expect(statements).toContain(
      'CREATE INDEX post_title_idx IF NOT EXISTS FOR (n:Post) ON (n.title)'
    );
    expect(statements).toContain(
      'CREATE INDEX post_published_at_status_idx IF NOT EXISTS FOR (n:Post) ON (n.published_at, n.status)'
    );
    // A one-to-one foreign key is unique.
    expect(statements).toContain(
      'CREATE CONSTRAINT profile_user_id_unique IF NOT EXISTS FOR (n:Profile) REQUIRE n.user_id IS UNIQUE'
    );
  });

  it('leaves out every Enterprise Edition statement and says so in a comment', async () => {
    const { output } = await convertCanonicalPrisma();
    expect(output).not.toMatch(/IS NOT NULL;|IS NODE KEY|IS ::/);
    expect(output).toContain(
      '// Required properties (IS NOT NULL needs Enterprise Edition): id, created_at'
    );
    expect(output).toContain('Style: community.');
  });

  it('writes a composite primary key as a composite uniqueness constraint with a comment', () => {
    const { text } = emit(keysSchema());
    expect(text).toContain(
      '// Composite primary key (year, number): NODE KEY needs Enterprise Edition, so a uniqueness constraint is used.'
    );
    expect(text).toContain(
      'CREATE CONSTRAINT ledger_year_number_unique IF NOT EXISTS FOR (n:Ledger) REQUIRE (n.year, n.number) IS UNIQUE;'
    );
  });

  it('documents the property types in a comment block, with the enum values', async () => {
    const { output } = await convertCanonicalPrisma();
    expect(output).toContain('//   id: INTEGER (required; primary key)');
    expect(output).toContain(
      '//   status: STRING (required; one of: "draft", "published")'
    );
    expect(output).toContain('//   created_at: ZONED DATETIME (required)');
    expect(output).toContain(
      '//   author_id: INTEGER (required; foreign key to User.id)'
    );
  });

  it('lists the foreign key properties in the header', async () => {
    const { output } = await convertCanonicalPrisma();
    expect(output).toContain(
      '// Foreign key properties kept: Category.parent_id, Post.author_id, Post.editor_id, Post.category_id, Profile.user_id'
    );
    expect(output).toContain('derived');
  });

  it('can leave the header out', () => {
    const { text } = emit(keysSchema(), { header: false });
    expect(text.startsWith('// ----')).toBe(true);
    expect(text).not.toContain('generated by ormbridge');
  });
});

describe('enterprise style', () => {
  it('adds IS NOT NULL and type constraints and keeps the uniqueness constraints', async () => {
    const { output } = await convertCanonicalPrisma({
      style: 'enterprise',
    });
    const statements: string[] = splitCypher(output);
    expect(statements).toContain(
      'CREATE CONSTRAINT post_id_unique IF NOT EXISTS FOR (n:Post) REQUIRE n.id IS UNIQUE'
    );
    expect(statements).toContain(
      'CREATE CONSTRAINT post_title_required IF NOT EXISTS FOR (n:Post) REQUIRE n.title IS NOT NULL'
    );
    expect(statements).toContain(
      'CREATE CONSTRAINT post_title_type IF NOT EXISTS FOR (n:Post) REQUIRE n.title IS :: STRING'
    );
    expect(statements).toContain(
      'CREATE CONSTRAINT post_published_at_type IF NOT EXISTS FOR (n:Post) REQUIRE n.published_at IS :: ZONED DATETIME'
    );
    // Optional properties get a type constraint but no IS NOT NULL.
    expect(statements).toContain(
      'CREATE CONSTRAINT post_rating_type IF NOT EXISTS FOR (n:Post) REQUIRE n.rating IS :: STRING'
    );
    expect(statements.join('\n')).not.toContain('n.rating IS NOT NULL');
    expect(output).toContain('Style: enterprise.');
    expect(output).not.toContain('Required properties (IS NOT NULL needs');
  });

  it('writes a composite primary key as a node key and skips IS NOT NULL for its parts', () => {
    const { text } = emit(keysSchema(), { style: 'enterprise' });
    const statements: string[] = splitCypher(text);
    expect(statements).toContain(
      'CREATE CONSTRAINT ledger_year_number_key IF NOT EXISTS FOR (n:Ledger) REQUIRE (n.year, n.number) IS NODE KEY'
    );
    expect(statements.join('\n')).not.toContain('n.year IS NOT NULL');
    expect(statements.join('\n')).not.toContain('n.number IS NOT NULL');
    expect(statements.join('\n')).toContain('n.code IS NOT NULL');
  });

  it('writes list types and no type constraint for byte arrays', () => {
    const { text } = emit(schemaOf([typesModel()]), { style: 'enterprise' });
    expect(text).toContain('REQUIRE n.labels IS :: LIST<STRING NOT NULL>;');
    expect(text).toContain('REQUIRE n.numbers IS :: LIST<INTEGER NOT NULL>;');
    expect(text).not.toContain('n.cover IS ::');
    expect(text).toContain('//   cover: BYTE ARRAY (optional)');
    expect(text).toContain('n.local_at IS :: LOCAL DATETIME;');
    expect(text).toContain('n.opens_tz IS :: ZONED TIME;');
    expect(text).toContain('n.span IS :: DURATION;');
  });
});

describe('style option', () => {
  it('accepts community and enterprise and names them in the error for other values', () => {
    expect(expectOk(checkStyle('neo4j', 'community'))).toBe('community');
    expect(expectOk(checkStyle('neo4j', 'enterprise'))).toBe('enterprise');
    const bad = checkStyle('neo4j', 'jakarta');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('INVALID_OPTION');
      expect(bad.error.message).toBe(
        'Invalid --style value "jakarta" for the neo4j format. Expected one of: community, enterprise.'
      );
    }
  });

  it('is rejected by the adapter for a value of another format', async () => {
    const result = await convertText(loadCanonicalSources('prisma'), {
      ...DEFAULT_OPTIONS,
      from: 'prisma',
      to: 'neo4j',
      style: 'fluent',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('for the neo4j format');
    }
  });

  it('is ignored by the other formats, which still accept it', async () => {
    const result = await convertText(loadCanonicalSources('prisma'), {
      ...DEFAULT_OPTIONS,
      from: 'prisma',
      to: 'zod',
      style: 'enterprise',
    });
    expect(result.ok).toBe(true);
  });
});

describe('naming modes', () => {
  it('preserve keeps the column names as property keys', async () => {
    const { output } = await convertCanonicalPrisma();
    expect(output).toContain('REQUIRE n.public_id IS UNIQUE');
  });

  it('normalize writes camelCase property keys and keeps the snake_case words in names', async () => {
    const { output } = await convertCanonicalPrisma({ naming: 'normalize' });
    expect(output).toContain(
      'CREATE CONSTRAINT post_public_id_unique IF NOT EXISTS FOR (n:Post) REQUIRE n.publicId IS UNIQUE;'
    );
    expect(output).toContain('Post.authorId');
    expect(output).not.toContain('n.public_id');
  });
});

describe('names and quoting', () => {
  it('quotes only names that are not plain identifiers', () => {
    expect(quoteIdentifier('title')).toBe('title');
    expect(quoteIdentifier('_x1')).toBe('_x1');
    expect(quoteIdentifier('order by')).toBe('`order by`');
    expect(quoteIdentifier('2fast')).toBe('`2fast`');
    expect(quoteIdentifier('back`tick')).toBe('`back``tick`');
    expect(quoteIdentifier('')).toBe('``');
  });

  it('makes labels PascalCase and singular and relationship types UPPER_SNAKE_CASE', () => {
    expect(labelOf('blog_posts')).toBe('BlogPost');
    expect(labelOf('Post')).toBe('Post');
    expect(labelOf('Categories')).toBe('Category');
    expect(relationshipTypeOf('editedBy')).toBe('EDITED_BY');
    expect(relationshipTypeOf('edited_by')).toBe('EDITED_BY');
    expect(relationshipTypeOf('---')).toBe('RELATED_TO');
    expect(oneLine('a\n  b\t c')).toBe('a b c');
  });

  it('backtick-quotes awkward property keys in statements and comments', () => {
    const schema: IrSchema = schemaOf([
      model('Odd', {
        fields: [
          idField(),
          field('select', { columnName: 'order by', isUnique: true }),
          field('tick', { columnName: 'back`tick', isUnique: true }),
          field('digits', { columnName: '2fast', isUnique: true }),
        ],
      }),
    ]);
    const { text } = emit(schema);
    expect(text).toContain('REQUIRE n.`order by` IS UNIQUE;');
    expect(text).toContain('REQUIRE n.`back``tick` IS UNIQUE;');
    expect(text).toContain('REQUIRE n.`2fast` IS UNIQUE;');
    expect(text).toContain('//   `order by`: STRING (required; unique)');
    expect(text).toContain('CREATE CONSTRAINT odd_order_by_unique ');
  });

  it('gives every constraint and index its own name', () => {
    const schema: IrSchema = schemaOf([
      model('A', {
        fields: [
          idField(),
          field('b_c', { isUnique: true }),
          field('b', { isUnique: true }),
          field('c', { isUnique: true }),
        ],
        indexes: [index(['b', 'c'], { isUnique: true })],
      }),
      model('A_b', {
        fields: [idField(), field('c', { isUnique: true })],
      }),
    ]);
    const names: string[] = splitCypher(emit(schema).text).map(
      (statement: string) =>
        /^CREATE (?:FULLTEXT )?(?:CONSTRAINT|INDEX) (\S+) /.exec(
          statement
        )?.[1] ?? ''
    );
    expect(names.every((name: string) => name !== '')).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('a_b_c_unique');
    expect(names).toContain('a_b_c_unique2');
  });

  it('numbers a label that two models share and warns', () => {
    const schema: IrSchema = schemaOf([
      model('User', { tableName: 'a' }),
      model('Users', { tableName: 'b' }),
    ]);
    const { text, warnings } = emit(schema);
    expect(text).toContain('FOR (n:User) REQUIRE');
    expect(text).toContain('FOR (n:User2) REQUIRE');
    expect(warnings).toContain(
      'Users: the label User is already used by another model; this model uses User2.'
    );
  });

  it('keeps comment text on one line', () => {
    const { text } = emit(schemaOf([typesModel()], []));
    for (const line of text.split('\n')) {
      expect(
        line === '' || line.startsWith('//') || line.startsWith('CREATE ')
      ).toBe(true);
    }
  });
});

describe('types', () => {
  it('maps scalars to Neo4j property types', () => {
    const map = (overrides: Parameters<typeof field>[1]): string =>
      mapFieldType(field('x', overrides)).type.name;
    expect(map({ type: 'string' })).toBe('STRING');
    expect(map({ type: 'text' })).toBe('STRING');
    expect(map({ type: 'uuid' })).toBe('STRING');
    expect(map({ type: 'int' })).toBe('INTEGER');
    expect(map({ type: 'bigInt' })).toBe('INTEGER');
    expect(map({ type: 'float' })).toBe('FLOAT');
    expect(map({ type: 'boolean' })).toBe('BOOLEAN');
    expect(map({ type: 'date' })).toBe('DATE');
    expect(map({ type: 'dateTime' })).toBe('ZONED DATETIME');
    expect(
      map({ type: 'dateTime', nativeType: { name: 'DateTime2', args: [] } })
    ).toBe('LOCAL DATETIME');
    expect(map({ type: 'time' })).toBe('LOCAL TIME');
    expect(map({ type: 'duration' })).toBe('DURATION');
    expect(map({ type: 'bytes' })).toBe('BYTE ARRAY');
    expect(map({ type: 'int', arrayDepth: 1 })).toBe('LIST<INTEGER NOT NULL>');
  });

  it('warns for decimal, JSON, hstore, range, unsupported and nested array columns', () => {
    const { warnings } = emit(schemaOf([typesModel()]));
    const text: string = warnings.join('\n');
    expect(text).toContain(
      'Item.price: Neo4j has no decimal type; the value is stored as a STRING'
    );
    expect(text).toContain(
      'Item.settings: Neo4j properties cannot hold JSON objects'
    );
    expect(text).toContain('Item.extra: Neo4j has no key-value property type');
    expect(text).toContain('Item.window: Neo4j has no range type');
    expect(text).toContain(
      'Item.shape: the database type "circle" has no Neo4j equivalent'
    );
    expect(text).toContain('Item.grid: Neo4j cannot store nested lists');
    expect(text).toContain(
      'Item.blobs: Neo4j cannot store a list of byte arrays'
    );
  });

  it('notes the allowed values of an enum field, on one line', () => {
    const schema: IrSchema = keysSchema();
    const { text } = emit(schema);
    expect(text).toContain(
      '//   kind: STRING (required; one of: "book", "film; "quoted" second line")'
    );
  });

  it('keeps the precision note of a decimal', () => {
    const { text } = emit(schemaOf([typesModel()]));
    expect(text).toContain(
      '//   price: STRING (optional; decimal with 8 digits, 2 after the point)'
    );
  });
});

describe('warnings', () => {
  it('names the model and field for every dropped default, auto-increment, length and generated column', () => {
    const { warnings } = emit(schemaOf([typesModel()]));
    const text: string = warnings.join('\n');
    expect(text).toContain(
      'Item.flag: the default true has no Neo4j schema representation and was dropped'
    );
    expect(text).toContain('Item.seen_at: the default of the current time');
    expect(text).toContain('Item.id: the default of a generated UUID');
    expect(text).toContain('Item.kind: the default "BOOK"');
    expect(text).toContain('Item.stamp: the value is refreshed on every save');
    expect(text).toContain(
      'Item.computed: the generated column expression (a || b)'
    );
    expect(text).toContain(
      'Item: the maximum length of title has no Neo4j schema representation'
    );
    const { warnings: autoIncrement } = emit(schemaOf([model('Plain')]));
    expect(autoIncrement).toContain(
      'Plain.id: auto-increment has no Neo4j equivalent; supply the value yourself (or use randomUUID() and a STRING key).'
    );
  });

  it('drops unsupported index methods, options and unknown columns with a warning', () => {
    const { text, warnings } = emit(keysSchema());
    expect(warnings).toContain(
      'Ledger index (memo): Neo4j has no Hash index method; the index was dropped.'
    );
    expect(warnings).toContain(
      'Ledger index (year): clustering, sort order, prefix length and operator class options have no Neo4j equivalent and were dropped.'
    );
    expect(warnings).toContain(
      'Ledger index (missing): it names a column that does not exist and was dropped.'
    );
    // The sort option does not stop the index from being written.
    expect(text).toContain(
      'CREATE INDEX ledger_year_idx IF NOT EXISTS FOR (n:Ledger) ON (n.year);'
    );
    expect(text).toContain(
      'CREATE FULLTEXT INDEX ledger_memo_fulltext IF NOT EXISTS FOR (n:Ledger) ON EACH [n.memo];'
    );
  });

  it('writes no index that a uniqueness constraint already backs', () => {
    const { text } = emit(keysSchema());
    // index(['memo', 'code']) is also unique, and index(['code']) is the unique column.
    expect(text).not.toContain('ledger_code_idx');
    expect(text).not.toContain('ledger_memo_code_idx');
    expect(text).toContain('ledger_memo_code_unique');
  });

  it('warns for each foreign key it can only document', async () => {
    const { warnings } = await convertCanonicalPrisma();
    expect(warnings).toContain(
      'Post.author: Neo4j keeps no relationship schema, so the foreign key to User (on delete cascade) is only documented in a comment; the author_id property was kept.'
    );
  });

  it('warns about views and database schemas', () => {
    const schema: IrSchema = schemaOf([
      model('Report', { isView: true, schema: 'analytics' }),
    ]);
    schema.enums.push({ name: 'E', schema: 'x', values: [] });
    const { warnings } = emit(schema);
    expect(warnings).toContain(
      'Report: this is a database view; it was written as a node label like any other model.'
    );
    expect(warnings).toContain(
      'Report: the database schema "analytics" (@@schema) was ignored.'
    );
    expect(warnings).toContain(
      'enum E: the database schema "x" (@@schema) was ignored.'
    );
  });

  it('writes nothing for an empty schema', () => {
    expect(emit(schemaOf([])).text).toBe('');
  });
});

describe('relationships', () => {
  it('documents each foreign key with pattern, cardinality, action and a MATCH ... MERGE query', async () => {
    const { output } = await convertCanonicalPrisma();
    expect(output).toContain('// (:Post)-[:AUTHOR]->(:User)');
    expect(output).toContain('//   many Post to one User, required.');
    expect(output).toContain(
      '//   foreign key property: Post.author_id references User.id'
    );
    expect(output).toContain(
      '//   on delete: cascade (delete the Post when its User is deleted); Neo4j does not enforce it.'
    );
    expect(output).toContain(
      '//   create: MATCH (s:Post), (t:User) WHERE s.author_id = t.id MERGE (s)-[:AUTHOR]->(t);'
    );
    expect(output).toContain('//   many Post to one User, optional.');
    expect(output).toContain('//   one Profile to one User, required.');
    expect(output).toContain('(:Category)-[:PARENT]->(:Category)');
  });

  it('writes a pure join table as one relationship and no node label', async () => {
    const { output, warnings } = await convertCanonicalPrisma();
    expect(output).toContain('// (:Post)-[:TAGS]->(:Tag)');
    expect(output).toContain(
      'from the join table blog_post_tags (model PostTags)'
    );
    expect(output).not.toContain('FOR (n:PostTag)');
    expect(output).not.toContain('(n:PostTags)');
    expect(warnings).toContain(
      'PostTags: the join table became a relationship, so its surrogate key id was dropped.'
    );
  });

  it('lists extra join table columns as relationship properties and constrains the unique ones', () => {
    const { text, warnings } = emit(joinsSchema());
    expect(text).toContain('// (:Student)-[:COURSES]->(:Course)');
    expect(text).toContain(
      '//   relationship properties: ticket STRING (required), role STRING (required), note STRING (optional), seat INTEGER (optional)'
    );
    expect(text).toContain(
      'CREATE CONSTRAINT courses_ticket_unique IF NOT EXISTS FOR ()-[r:COURSES]-() REQUIRE r.ticket IS UNIQUE;'
    );
    expect(text).toContain(
      'CREATE CONSTRAINT courses_seat_role_unique IF NOT EXISTS FOR ()-[r:COURSES]-() REQUIRE (r.seat, r.role) IS UNIQUE;'
    );
    expect(text).toContain('SET r.ticket = row.ticket');
    expect(warnings).toContain(
      'Enrollment index (note): the join table became a relationship, so this index was dropped.'
    );
  });

  it('adds relationship existence constraints only in the enterprise style, and only for a join table with unique columns', () => {
    const community: string = emit(joinsSchema()).text;
    const enterprise: string = emit(joinsSchema(), {
      style: 'enterprise',
    }).text;
    expect(community).not.toContain('r.role IS NOT NULL');
    expect(enterprise).toContain(
      'CREATE CONSTRAINT courses_role_required IF NOT EXISTS FOR ()-[r:COURSES]-() REQUIRE r.role IS NOT NULL;'
    );
    // The join table without unique columns has no relationship statements at all.
    expect(community).not.toContain('FOR ()-[r:CLUB]-()');
    expect(enterprise).not.toContain('FOR ()-[r:CLUB]-()');
  });

  it('treats a table whose composite key is its two foreign keys as a join table', () => {
    const { text } = emit(joinsSchema());
    expect(text).toContain('// (:Student)-[:CLUB]->(:Club)');
    expect(text).toContain('(model Membership)');
    expect(text).not.toContain('(n:Membership)');
  });

  it('writes a many-to-many relation once even when both sides declare it', () => {
    const { text } = emit(joinsSchema());
    const patterns: string[] = text
      .split('\n')
      .filter((line: string) =>
        /^\/\/ \(:\w+\)-\[:\w+\]->\(:\w+\)$/.test(line)
      );
    expect(patterns).toContain('// (:Course)-[:TEACHERS]->(:Teacher)');
    expect(patterns).not.toContain('// (:Teacher)-[:COURSES]->(:Course)');
  });

  it('keeps a table with an extra relation, or one that other models point at, as a node', () => {
    const owner: IrModel = model('Owner');
    const pet: IrModel = model('Pet');
    const link: IrModel = model('Link', {
      relations: [relation('owner', 'Owner'), relation('pet', 'Pet')],
      indexes: [index(['owner', 'pet'], { isUnique: true })],
    });
    const note: IrModel = model('Note', {
      relations: [relation('link', 'Link')],
    });
    const { text } = emit(schemaOf([owner, pet, link, note]));
    expect(text).toContain('(n:Link)');
    expect(text).toContain('// (:Note)-[:LINK]->(:Link)');
    expect(text).toContain('// (:Link)-[:OWNER]->(:Owner)');
  });

  it('keeps a join table with an optional foreign key as a node', () => {
    const a: IrModel = model('A');
    const b: IrModel = model('B');
    const link: IrModel = model('Link', {
      relations: [relation('a', 'A'), relation('b', 'B', { isNullable: true })],
      indexes: [index(['a', 'b'], { isUnique: true })],
    });
    expect(emit(schemaOf([a, b, link])).text).toContain('(n:Link)');
  });

  it('documents a composite foreign key with one WHERE clause over all its properties', () => {
    const { text } = emit(keysSchema());
    expect(text).toContain('// (:LineItem)-[:LEDGER]->(:Ledger)');
    expect(text).toContain(
      '//   foreign key properties: LineItem.ledger_year, LineItem.ledger_number reference Ledger.year, Ledger.number'
    );
    expect(text).toContain(
      'WHERE s.ledger_year = t.year AND s.ledger_number = t.number MERGE (s)-[:LEDGER]->(t);'
    );
  });

  it('uses the foreign key properties named by to_field', () => {
    const target: IrModel = model('Country', {
      fields: [idField(), field('code', { isUnique: true })],
    });
    const source: IrModel = model('City', {
      relations: [relation('country', 'Country', { toField: 'code' })],
    });
    const { text } = emit(schemaOf([target, source]));
    expect(text).toContain('references Country.code');
    expect(text).toContain('WHERE s.country_id = t.code MERGE');
    expect(text).toContain(
      '//   country_id: STRING (required; foreign key to Country.code)'
    );
  });
});

describe('coverage check', () => {
  it('finds nothing missing in the canonical output and reports what a tampered output lacks', async () => {
    const parse = expectOk(getFormat('prisma')).parse;
    if (parse === undefined) {
      throw new Error('The prisma format has no parser.');
    }
    const schema: IrSchema = expectOk(
      await parse(loadCanonicalSources('prisma'), DEFAULT_OPTIONS)
    );
    const output: string = emit(schema).text;
    expect(checkNeo4jOutput(schema, { neo4j: output })).toEqual([]);
    const tampered: string = output
      .replace(/^\/\/ {3}author_id: .*\n/m, '')
      .replace('(:Post)-[:TAGS]->(:Tag)', '(:Post)-[:OTHER]->(:Tag)')
      .replace(/^\/\/ :User .*$/m, '// :Gone');
    const missing: string[] = checkNeo4jOutput(schema, { neo4j: tampered });
    expect(missing.length).toBeGreaterThanOrEqual(2);
    expect(missing.join('\n')).toContain('Post.author');
  });
});
