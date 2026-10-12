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

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare id: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare name: string;
  declare slug: string;
  declare parent_id: CreationOptional<number | null>;

  declare parent?: NonAttribute<Category>;
  declare children?: NonAttribute<Category[]>;
  declare posts?: NonAttribute<Post[]>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        slug: { type: DataTypes.STRING(50), allowNull: false },
        parent_id: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Category',
        tableName: 'blog_category',
        timestamps: true,
        underscored: true,
      }
    );
    return Category;
  }
}
