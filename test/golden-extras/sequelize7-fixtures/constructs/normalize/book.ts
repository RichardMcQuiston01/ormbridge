import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Audiobook } from './audiobook.js';
import { Author } from './author.js';
import { Series } from './series.js';

@Table({
  tableName: 'book',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['title', 'author_id'] },
    { name: 'books_published_idx', fields: ['published_on'] },
  ],
})
export class Book extends Model<
  InferAttributes<Book>,
  InferCreationAttributes<Book>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.ARRAY(DataTypes.TEXT))
  @NotNull
  @Default([])
  declare tags: CreationOptional<string[]>;

  @Attribute(DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)))
  declare grid: CreationOptional<number[][] | null>;

  @Attribute(DataTypes.ARRAY(DataTypes.ENUM('red', 'green')))
  declare colors: CreationOptional<('red' | 'green')[] | null>;

  @Attribute(DataTypes.ENUM('red', 'green'))
  @NotNull
  @Default('red')
  declare color: CreationOptional<'red' | 'green'>;

  @Attribute(DataTypes.DECIMAL(8, 2))
  @NotNull
  @Default(9.99)
  declare price: CreationOptional<string>;

  @Attribute(DataTypes.JSONB)
  @NotNull
  @Default({ theme: 'dark', tabs: [1, 2] })
  declare settings: CreationOptional<unknown>;

  @Attribute(DataTypes.DATEONLY)
  @NotNull
  @Default(DataTypes.NOW)
  declare publishedOn: CreationOptional<string>;

  @Attribute(DataTypes.TIME)
  declare opensAt: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  @Default('2020-01-02T03:04:05Z')
  declare releasedAt: CreationOptional<Date | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(100)
  declare pages: CreationOptional<number>;

  @Attribute(DataTypes.DOUBLE)
  @NotNull
  @Default(0.5)
  declare ratio: CreationOptional<number>;

  @Attribute(DataTypes.BOOLEAN)
  @NotNull
  @Default(true)
  declare inPrint: CreationOptional<boolean>;

  @Attribute(DataTypes.TEXT)
  declare notes: CreationOptional<string | null>;

  @Attribute(DataTypes.RANGE(DataTypes.INTEGER))
  declare window: CreationOptional<unknown | null>;

  @Attribute(DataTypes.HSTORE)
  declare extra: CreationOptional<Record<string, string | null> | null>;

  @Attribute(DataTypes.BIGINT)
  declare readTime: CreationOptional<string | null>;

  @Attribute(DataTypes.BLOB)
  declare cover: CreationOptional<Buffer | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare authorId: string;

  @Attribute(DataTypes.UUID)
  declare editorId: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(20))
  declare seriesHandle: CreationOptional<string | null>;

  declare latestFor?: NonAttribute<Author[]>;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'authorId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'books' },
  })
  declare author?: NonAttribute<Author>;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'editorId', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'editedBooks' },
  })
  declare editor?: NonAttribute<Author>;

  @BelongsTo(() => Series, {
    foreignKey: { name: 'seriesHandle', onDelete: 'SET NULL' },
    targetKey: 'handle',
  })
  declare series?: NonAttribute<Series>;

  declare audiobook?: NonAttribute<Audiobook>;
}
