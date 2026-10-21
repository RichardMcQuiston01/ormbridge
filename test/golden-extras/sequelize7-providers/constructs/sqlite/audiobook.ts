import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Book } from './book.js';

@Table({ tableName: 'audiobooks', timestamps: false })
export class Audiobook extends Model<
  InferAttributes<Audiobook>,
  InferCreationAttributes<Audiobook>
> {
  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare minutes: number;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare book_ptr_id: number;

  @BelongsTo(() => Book, {
    foreignKey: { name: 'book_ptr_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'audiobook' },
  })
  declare book?: NonAttribute<Book>;
}
