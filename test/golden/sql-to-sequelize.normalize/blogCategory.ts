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

export class BlogCategory extends Model<
  InferAttributes<BlogCategory>,
  InferCreationAttributes<BlogCategory>
> {
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare updatedAt: Date;
  declare name: string;
  declare slug: string;
  declare parentId: CreationOptional<string | null>;

  declare parent?: NonAttribute<BlogCategory>;
  declare blogCategories?: NonAttribute<BlogCategory[]>;
  declare blogPosts?: NonAttribute<BlogPost[]>;

  static initModel(sequelize: Sequelize): typeof BlogCategory {
    BlogCategory.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        slug: { type: DataTypes.STRING(50), allowNull: false },
        parentId: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'BlogCategory',
        tableName: 'blog_category',
        timestamps: true,
        updatedAt: false,
        underscored: true,
      }
    );
    return BlogCategory;
  }
}
