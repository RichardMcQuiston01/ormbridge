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
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Book } from './book.js';

@Table({ tableName: 'audiobook', timestamps: true, underscored: true })
export class Audiobook extends Model<
  InferAttributes<Audiobook>,
  InferCreationAttributes<Audiobook>
> {
  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare minutes: number;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare bookPtrId: string;

  @BelongsTo(() => Book, {
    foreignKey: { name: 'bookPtrId', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'audiobook' },
  })
  declare book?: NonAttribute<Book>;
}
