import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Post } from './post.js';
import type { Tag } from './tag.js';

export class PostTag extends Model<
  InferAttributes<PostTag>,
  InferCreationAttributes<PostTag>
> {
  declare postId: number;
  declare tagId: number;

  declare post?: NonAttribute<Post>;
  declare tag?: NonAttribute<Tag>;

  static initModel(sequelize: Sequelize): typeof PostTag {
    PostTag.init(
      {
        postId: { type: DataTypes.INTEGER, primaryKey: true },
        tagId: { type: DataTypes.INTEGER, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'PostTag',
        tableName: 'post_tags',
        timestamps: false,
      }
    );
    return PostTag;
  }
}
