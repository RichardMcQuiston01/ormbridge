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
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import type { Book } from './book.js';

@Table({ tableName: 'authors', timestamps: true })
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
  declare name: string;

  @Attribute(DataTypes.TEXT)
  declare bio: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  declare createdAt: CreationOptional<Date | null>;

  @Attribute(DataTypes.DATE)
  declare updatedAt: CreationOptional<Date | null>;

  declare books?: NonAttribute<Book[]>;
}
