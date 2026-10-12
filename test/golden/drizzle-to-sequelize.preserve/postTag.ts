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
  declare post_id: number;
  declare tag_id: number;

  declare post?: NonAttribute<Post>;
  declare tag?: NonAttribute<Tag>;

  static initModel(sequelize: Sequelize): typeof PostTag {
    PostTag.init(
      {
        post_id: { type: DataTypes.INTEGER, primaryKey: true },
        tag_id: { type: DataTypes.INTEGER, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'PostTag',
        tableName: 'blog_post_tags',
        timestamps: false,
      }
    );
    return PostTag;
  }
}
