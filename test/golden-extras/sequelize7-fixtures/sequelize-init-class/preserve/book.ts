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
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Author } from './author.js';

@Table({
  tableName: 'books',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['title'] },
  ],
})
export class Book extends Model<
  InferAttributes<Book>,
  InferCreationAttributes<Book>
> {
  @Attribute(DataTypes.BIGINT)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(255))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.STRING(13))
  @Unique
  declare isbn: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @Default(0)
  declare pages: CreationOptional<number | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare author_id: number;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'author_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'books' },
  })
  declare author?: NonAttribute<Author>;
}
