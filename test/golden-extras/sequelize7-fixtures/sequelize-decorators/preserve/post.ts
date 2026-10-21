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
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Author } from './author.js';
import { Category } from './category.js';

@Table({
  tableName: 'posts',
  timestamps: true,
  indexes: [
    { fields: ['title'] },
    { name: 'posts_author_slug', unique: true, fields: ['slug', 'authorId'] },
    { name: 'posts_status_idx', fields: ['status', 'publishedAt'] },
  ],
})
export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(200))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  declare slug: string;

  @Attribute(DataTypes.STRING(20))
  @Default('draft')
  declare status: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  declare publishedAt: CreationOptional<Date | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare authorId: number;

  @Attribute(DataTypes.INTEGER)
  declare categoryId: CreationOptional<number | null>;

  @BelongsTo(() => Author, {
    foreignKey: { name: 'authorId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'posts' },
  })
  declare author?: NonAttribute<Author>;

  @BelongsTo(() => Category, {
    foreignKey: { name: 'categoryId', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'posts' },
  })
  declare category?: NonAttribute<Category>;
}
