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
  BelongsToMany,
  CreatedAt,
  Default,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Book } from './book.js';

@Table({ tableName: 'tagged', timestamps: true, underscored: true })
export class Tagged extends Model<
  InferAttributes<Tagged>,
  InferCreationAttributes<Tagged>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @BelongsToMany(() => Book, {
    through: { model: 'tagged_books', timestamps: false },
    foreignKey: 'tagged_id',
    otherKey: 'book_id',
  })
  declare books?: NonAttribute<Book[]>;
}
