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
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Post } from './post.js';
import { Tag } from './tag.js';

@Table({ tableName: 'post_tag', timestamps: true, underscored: true })
export class PostTag extends Model<
  InferAttributes<PostTag>,
  InferCreationAttributes<PostTag>
> {
  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare postId: string;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare tagId: string;

  @BelongsTo(() => Post, {
    foreignKey: { name: 'postId', onDelete: 'CASCADE' },
  })
  declare post?: NonAttribute<Post>;

  @BelongsTo(() => Tag, { foreignKey: { name: 'tagId', onDelete: 'CASCADE' } })
  declare tag?: NonAttribute<Tag>;
}
