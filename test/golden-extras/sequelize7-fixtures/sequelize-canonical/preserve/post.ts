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
  BelongsToMany,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Category } from './category.js';
import { Tag } from './tag.js';
import { User } from './user.js';

@Table({
  tableName: 'blog_post',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['title'] },
    { unique: true, fields: ['author_id', 'title'] },
    { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
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
  declare rating: CreationOptional<string | null>;

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

  @Attribute(DataTypes.JSONB)
  @NotNull
  @Default({})
  declare metadata: CreationOptional<unknown>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare author_id: number;

  @Attribute(DataTypes.INTEGER)
  declare editor_id: CreationOptional<number | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare category_id: number;

  @BelongsTo(() => User, {
    foreignKey: { name: 'author_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'posts' },
  })
  declare author?: NonAttribute<User>;

  @BelongsTo(() => User, {
    foreignKey: { name: 'editor_id', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'editedPosts' },
  })
  declare editor?: NonAttribute<User>;

  @BelongsTo(() => Category, {
    foreignKey: { name: 'category_id', onDelete: 'RESTRICT' },
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
