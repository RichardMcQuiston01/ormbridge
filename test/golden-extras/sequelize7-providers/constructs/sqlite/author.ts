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
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';
import { Book } from './book.js';

@Table({ tableName: 'authors', timestamps: false })
export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(30))
  @NotNull
  @Unique
  declare handle: string;

  @Attribute(DataTypes.INTEGER)
  declare favourite_book_id: CreationOptional<number | null>;

  @Attribute(DataTypes.INTEGER)
  declare latest_book_id: CreationOptional<number | null>;

  @BelongsTo(() => Book, {
    foreignKey: { name: 'latest_book_id', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'latest_for' },
  })
  declare latest_book?: NonAttribute<Book>;

  declare books?: NonAttribute<Book[]>;
  declare edited_books?: NonAttribute<Book[]>;
}
