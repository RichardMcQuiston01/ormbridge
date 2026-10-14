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
  declare id: CreationOptional<number>;
  declare readonly created_at: CreationOptional<Date>;
  declare updated_at: Date;
  declare name: string;
  declare slug: string;
  declare parent_id: CreationOptional<number | null>;

  declare parent?: NonAttribute<BlogCategory>;
  declare blog_categories?: NonAttribute<BlogCategory[]>;
  declare blog_posts?: NonAttribute<BlogPost[]>;

  static initModel(sequelize: Sequelize): typeof BlogCategory {
    BlogCategory.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        slug: { type: DataTypes.STRING(50), allowNull: false },
        parent_id: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'BlogCategory',
        tableName: 'blog_category',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false,
      }
    );
    return BlogCategory;
  }
}
