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

export class PostTag extends Model<
  InferAttributes<PostTag>,
  InferCreationAttributes<PostTag>
> {
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare postId: string;
  declare tagId: string;

  declare post?: NonAttribute<Post>;
  declare tag?: NonAttribute<Tag>;

  static initModel(sequelize: Sequelize): typeof PostTag {
    PostTag.init(
      {
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        postId: { type: DataTypes.UUID, primaryKey: true },
        tagId: { type: DataTypes.UUID, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'PostTag',
        tableName: 'post_tag',
        timestamps: true,
        underscored: true,
      }
    );
    return PostTag;
  }
}
