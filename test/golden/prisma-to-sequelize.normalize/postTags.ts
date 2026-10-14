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
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare postId: string;
  declare tagId: string;

  declare post?: NonAttribute<Post>;
  declare tag?: NonAttribute<Tag>;

  static initModel(sequelize: Sequelize): typeof PostTags {
    PostTags.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        postId: { type: DataTypes.UUID, allowNull: false },
        tagId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'PostTags',
        tableName: 'post_tag',
        timestamps: true,
        underscored: true,
        indexes: [
          { unique: true, fields: ['post_id', 'tag_id'] },
        ],
      }
    );
    return PostTags;
  }
}
