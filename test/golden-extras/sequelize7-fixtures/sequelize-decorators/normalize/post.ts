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
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Author } from './author.js';
import { Category } from './category.js';

@Table({
  tableName: 'post',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['title'] },
    { name: 'posts_author_slug', unique: true, fields: ['slug', 'author_id'] },
    { name: 'posts_status_idx', fields: ['status', 'published_at'] },
  ],
})
export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

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

  @Attribute(DataTypes.UUID)
  @NotNull
  declare authorId: string;

  @Attribute(DataTypes.UUID)
  declare categoryId: CreationOptional<string | null>;

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
