import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { BlogPost } from './blogPost.js';

export class BlogTag extends Model<
  InferAttributes<BlogTag>,
  InferCreationAttributes<BlogTag>
> {
  declare id: CreationOptional<string>;
  declare label: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare blogPosts?: NonAttribute<BlogPost[]>;

  static initModel(sequelize: Sequelize): typeof BlogTag {
    BlogTag.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        label: { type: DataTypes.STRING(50), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'BlogTag',
        tableName: 'blog_tag',
        timestamps: true,
        underscored: true,
      }
    );
    return BlogTag;
  }
}
