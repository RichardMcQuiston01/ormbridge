import { DataTypes, Model } from '@sequelize/core';
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  BelongsToMany,
  Default,
  NotNull,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';
import { Category } from './category.js';
import { Tag } from './tag.js';
import { User } from './user.js';

@Table({
  tableName: 'blog_post',
  underscored: true,
  indexes: [
    { fields: ['title'] },
    { fields: ['author_id', 'title'], unique: true },
    { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
  ],
})
export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  @Attribute(DataTypes.UUID)
  @NotNull
  @Unique
  @Default(DataTypes.UUIDV4)
  declare publicId: CreationOptional<string>;

  @Attribute(DataTypes.STRING(200))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.TEXT)
  @NotNull
  declare body: string;

  @Attribute(DataTypes.ENUM('draft', 'published'))
  @NotNull
  @Default('draft')
  declare status: CreationOptional<'draft' | 'published'>;

  @Attribute(DataTypes.DECIMAL(4, 2))
  declare rating: string | null;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(0)
  declare viewCount: CreationOptional<number>;

  @Attribute(DataTypes.BOOLEAN)
  @NotNull
  @Default(false)
  declare isFeatured: CreationOptional<boolean>;

  @Attribute(DataTypes.DATE)
  @NotNull
  @Default(DataTypes.NOW)
  declare publishedAt: CreationOptional<Date>;

  @Attribute(DataTypes.JSON)
  @NotNull
  @Default({})
  declare metadata: CreationOptional<object>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare authorId: number;

  @BelongsTo(() => User, {
    foreignKey: { name: 'authorId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'posts' },
  })
  declare author?: NonAttribute<User>;

  @Attribute(DataTypes.INTEGER)
  declare editorId: number | null;

  @BelongsTo(() => User, {
    foreignKey: { name: 'editorId', allowNull: true, onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'editedPosts' },
  })
  declare editor?: NonAttribute<User>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare categoryId: number;

  @BelongsTo(() => Category, {
    foreignKey: { name: 'categoryId', allowNull: false, onDelete: 'RESTRICT' },
  })
  declare category?: NonAttribute<Category>;

  @BelongsToMany(() => Tag, {
    through: { model: 'blog_post_tags', timestamps: false },
    foreignKey: 'post_id',
    otherKey: 'tag_id',
    inverse: 'posts',
  })
  declare tags?: NonAttribute<Tag[]>;
}
