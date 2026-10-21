import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Post } from './post.js';
import { Tag } from './tag.js';

@Table({ tableName: 'post_tags', timestamps: false })
export class PostTag extends Model<
  InferAttributes<PostTag>,
  InferCreationAttributes<PostTag>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare postId: number;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare tagId: number;

  @BelongsTo(() => Post, {
    foreignKey: { name: 'postId', onDelete: 'CASCADE' },
  })
  declare post?: NonAttribute<Post>;

  @BelongsTo(() => Tag, { foreignKey: { name: 'tagId', onDelete: 'CASCADE' } })
  declare tag?: NonAttribute<Tag>;
}
