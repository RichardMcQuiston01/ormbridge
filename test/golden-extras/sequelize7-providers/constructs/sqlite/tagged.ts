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
  BelongsToMany,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Book } from './book.js';

@Table({ tableName: 'tagged', timestamps: false })
export class Tagged extends Model<
  InferAttributes<Tagged>,
  InferCreationAttributes<Tagged>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @BelongsToMany(() => Book, {
    through: { model: 'tagged_books', timestamps: false },
    foreignKey: 'tagged_id',
    otherKey: 'book_id',
  })
  declare books?: NonAttribute<Book[]>;
}
