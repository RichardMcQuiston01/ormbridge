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
import { Author } from './author.js';

@Table({
  tableName: 'book',
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
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
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

  @Attribute(DataTypes.UUID)
  @NotNull
  declare authorId: string;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'authorId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'books' },
  })
  declare author?: NonAttribute<Author>;
}
