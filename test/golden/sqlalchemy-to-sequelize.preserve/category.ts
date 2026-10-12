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
  declare readonly created_at: CreationOptional<Date>;
  declare readonly updated_at: CreationOptional<Date>;
  declare id: CreationOptional<number>;
  declare name: string;
  declare slug: string;
  declare parent_id: CreationOptional<number | null>;

  declare parent?: NonAttribute<Category>;
  declare children?: NonAttribute<Category[]>;
  declare posts?: NonAttribute<Post[]>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
      {
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        slug: { type: DataTypes.STRING(50), allowNull: false },
        parent_id: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Category',
        tableName: 'blog_category',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }
    );
    return Category;
  }
}
