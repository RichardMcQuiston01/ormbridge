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
  AutoIncrement,
  BelongsTo,
  Default,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import type { Audiobook } from './audiobook.js';
import { Author } from './author.js';
import { Series } from './series.js';

@Table({
  tableName: 'books',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['title', 'author_id'] },
    { name: 'books_published_idx', fields: ['published_on'] },
  ],
})
export class Book extends Model<
  InferAttributes<Book>,
  InferCreationAttributes<Book>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.JSON)
  @NotNull
  @Default([])
  declare tags: CreationOptional<string[]>;

  @Attribute(DataTypes.JSON)
  declare grid: CreationOptional<number[][] | null>;

  @Attribute(DataTypes.JSON)
  declare colors: CreationOptional<('red' | 'green')[] | null>;

  @Attribute(DataTypes.ENUM('red', 'green'))
  @NotNull
  @Default('red')
  declare color: CreationOptional<'red' | 'green'>;

  @Attribute(DataTypes.DOUBLE)
  @NotNull
  @Default(9.99)
  declare price: CreationOptional<number>;

  @Attribute(DataTypes.JSON)
  @NotNull
  @Default({ theme: 'dark', tabs: [1, 2] })
  declare settings: CreationOptional<unknown>;

  @Attribute(DataTypes.DATEONLY)
  @NotNull
  @Default(DataTypes.NOW)
  declare published_on: CreationOptional<string>;

  @Attribute(DataTypes.TIME)
  declare opens_at: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  @Default('2020-01-02T03:04:05Z')
  declare released_at: CreationOptional<Date | null>;

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
  declare in_print: CreationOptional<boolean>;

  @Attribute(DataTypes.TEXT)
  declare notes: CreationOptional<string | null>;

  @Attribute(DataTypes.TEXT)
  declare window: CreationOptional<string | null>;

  @Attribute(DataTypes.JSON)
  declare extra: CreationOptional<Record<string, string | null> | null>;

  @Attribute(DataTypes.INTEGER)
  declare read_time: CreationOptional<number | null>;

  @Attribute(DataTypes.BLOB)
  declare cover: CreationOptional<Buffer | null>;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare author_id: string;

  @Attribute(DataTypes.UUID)
  declare editor_id: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(20))
  declare series_handle: CreationOptional<string | null>;

  declare latest_for?: NonAttribute<Author[]>;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'author_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'books' },
  })
  declare author?: NonAttribute<Author>;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'editor_id', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'edited_books' },
  })
  declare editor?: NonAttribute<Author>;

  @BelongsTo(() => Series, {
    foreignKey: { name: 'series_handle', onDelete: 'SET NULL' },
    targetKey: 'handle',
  })
  declare series?: NonAttribute<Series>;

  declare audiobook?: NonAttribute<Audiobook>;
}
