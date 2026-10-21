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
  tableName: 'post',
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
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

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

  @Attribute(DataTypes.UUID)
  @NotNull
  declare authorId: string;

  @Attribute(DataTypes.UUID)
  declare editorId: CreationOptional<string | null>;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare categoryId: string;

  @BelongsTo(() => User, {
    foreignKey: { name: 'authorId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'posts' },
  })
  declare author?: NonAttribute<User>;

  @BelongsTo(() => User, {
    foreignKey: { name: 'editorId', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'editedPosts' },
  })
  declare editor?: NonAttribute<User>;

  @BelongsTo(() => Category, {
    foreignKey: { name: 'categoryId', onDelete: 'RESTRICT' },
  })
  declare category?: NonAttribute<Category>;

  @BelongsToMany(() => Tag, {
    through: { model: 'post_tags', timestamps: false },
    foreignKey: 'post_id',
    otherKey: 'tag_id',
    inverse: 'posts',
  })
  declare tags?: NonAttribute<Tag[]>;
}
