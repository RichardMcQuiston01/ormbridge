import { DataTypes, Model, sql } from '@sequelize/core';
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from '@sequelize/core';
import {
  AllowNull,
  Attribute,
  AutoIncrement,
  BelongsTo,
  BelongsToMany,
  ColumnName,
  Comment,
  CreatedAt,
  Default,
  DeletedAt,
  HasMany,
  HasOne,
  Index,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
  Version,
} from '@sequelize/core/decorators-legacy';

// Sequelize 7 (@sequelize/core): decorated models. Foreign keys are named in the association decorators, and
// their actions sit in the foreignKey option.
@Table({ tableName: 'authors', paranoid: true })
export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(80))
  @NotNull
  @Unique
  declare email: string;

  @Attribute(DataTypes.TEXT)
  declare bio: string | null;

  @Attribute(DataTypes.ENUM('active', 'banned'))
  @NotNull
  @Default('active')
  declare state: CreationOptional<'active' | 'banned'>;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Unique
  @Default(sql.uuidV4.asJavaScript)
  declare publicId: CreationOptional<string>;

  @CreatedAt
  declare createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare updatedAt: CreationOptional<Date>;

  @DeletedAt
  declare deletedAt: Date | null;

  // HasMany and HasOne define the BelongsTo on the other model from their `inverse` option.
  @HasMany(() => Post, { foreignKey: 'authorId', inverse: 'author' })
  declare posts?: NonAttribute<Post[]>;

  @HasOne(() => Profile, {
    foreignKey: { name: 'authorId', onDelete: 'CASCADE' },
    inverse: 'author',
  })
  declare profile?: NonAttribute<Profile>;
}

@Table({ tableName: 'profiles', timestamps: false })
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Unique
  declare authorId: number;

  declare author?: NonAttribute<Author>;
}

// Not underscored: the indexes name the attributes, which are the columns.
@Table({ tableName: 'posts' })
export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(200))
  @NotNull
  @Index
  declare title: string;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  @Index({ name: 'posts_author_slug', unique: true })
  declare slug: string;

  @Attribute(DataTypes.STRING(20))
  @Default('draft')
  @Index({ name: 'posts_status_idx' })
  declare status: CreationOptional<string>;

  @Attribute(DataTypes.DATE)
  @Comment('When the post went live')
  @Index({ name: 'posts_status_idx' })
  declare publishedAt: Date | null;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Index({ name: 'posts_author_slug', unique: true })
  declare authorId: number;

  declare author?: NonAttribute<Author>;

  @Attribute(DataTypes.INTEGER)
  declare categoryId: number | null;

  @BelongsTo(() => Category, {
    foreignKey: { name: 'categoryId', onDelete: 'SET NULL' },
  })
  declare category?: NonAttribute<Category>;

  @Version
  declare version: CreationOptional<number>;

  @BelongsToMany(() => Tag, {
    through: () => PostTag,
    foreignKey: 'postId',
    otherKey: 'tagId',
  })
  declare tags?: NonAttribute<Tag[]>;
}

@Table({ tableName: 'categories', timestamps: false })
export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(60))
  @NotNull
  declare name: string;

  @Attribute(DataTypes.INTEGER)
  declare parentId: number | null;

  @HasMany(() => Category, {
    foreignKey: { name: 'parentId', onDelete: 'SET NULL' },
    inverse: { as: 'parent' },
  })
  declare children?: NonAttribute<Category[]>;

  declare parent?: NonAttribute<Category>;
}

@Table({ tableName: 'tags', timestamps: false })
export class Tag extends Model<
  InferAttributes<Tag>,
  InferCreationAttributes<Tag>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare label: string;

  @BelongsToMany(() => Post, {
    through: () => PostTag,
    foreignKey: 'tagId',
    otherKey: 'postId',
  })
  declare posts?: NonAttribute<Post[]>;
}

// The join model: it has no key of its own, so the two foreign keys are its primary key.
@Table({ tableName: 'post_tags', timestamps: false })
export class PostTag extends Model<
  InferAttributes<PostTag>,
  InferCreationAttributes<PostTag>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare postId: number;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare tagId: number;
}

// Column types, column names and a model without a primary key.
@Table({ tableName: 'ledger', timestamps: false, underscored: true })
export class Ledger extends Model<
  InferAttributes<Ledger>,
  InferCreationAttributes<Ledger>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.BIGINT)
  declare hits: string | null;

  @Attribute(DataTypes.DECIMAL(12, 2))
  @NotNull
  @Default(0)
  declare balance: CreationOptional<string>;

  @Attribute(DataTypes.DOUBLE)
  @AllowNull
  declare ratio: number | null;

  @Attribute(DataTypes.DATEONLY)
  @ColumnName('opened_on')
  declare openedOn: string | null;

  @Attribute(DataTypes.BLOB)
  declare receipt: Buffer | null;

  @Attribute(DataTypes.JSON)
  declare settings: object | null;
}

@Table({ tableName: 'audit_log', timestamps: false, noPrimaryKey: true })
export class AuditLog extends Model<
  InferAttributes<AuditLog>,
  InferCreationAttributes<AuditLog>
> {
  @Attribute(DataTypes.TEXT)
  declare message: string | null;
}

export const models = [
  Author,
  Profile,
  Post,
  Category,
  Tag,
  PostTag,
  Ledger,
  AuditLog,
];
