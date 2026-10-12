import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Post } from './post.js';
import type { Tag } from './tag.js';

export class PostTags extends Model<
  InferAttributes<PostTags>,
  InferCreationAttributes<PostTags>
> {
  declare id: CreationOptional<number>;
  declare post_id: number;
  declare tag_id: number;

  declare post?: NonAttribute<Post>;
  declare tag?: NonAttribute<Tag>;

  static initModel(sequelize: Sequelize): typeof PostTags {
    PostTags.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        post_id: { type: DataTypes.INTEGER, allowNull: false },
        tag_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'PostTags',
        tableName: 'blog_post_tags',
        timestamps: false,
        indexes: [
          { unique: true, fields: ['post_id', 'tag_id'] },
        ],
      }
    );
    return PostTags;
  }
}
