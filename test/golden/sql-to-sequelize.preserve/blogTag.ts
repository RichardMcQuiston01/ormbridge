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
  declare id: CreationOptional<number>;
  declare label: string;

  declare blog_posts?: NonAttribute<BlogPost[]>;

  static initModel(sequelize: Sequelize): typeof BlogTag {
    BlogTag.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        label: { type: DataTypes.STRING(50), allowNull: false },
      },
      {
        sequelize,
        modelName: 'BlogTag',
        tableName: 'blog_tag',
        timestamps: false,
      }
    );
    return BlogTag;
  }
}
