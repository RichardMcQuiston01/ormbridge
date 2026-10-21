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
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Book } from './book.js';

@Table({ tableName: 'author', timestamps: true, underscored: true })
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
  declare favouriteBookId: CreationOptional<number | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare latestBookId: CreationOptional<string | null>;

  @BelongsTo(() => Book, {
    foreignKey: { name: 'latestBookId', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'latestFor' },
  })
  declare latestBook?: NonAttribute<Book>;

  declare books?: NonAttribute<Book[]>;
  declare editedBooks?: NonAttribute<Book[]>;
}
