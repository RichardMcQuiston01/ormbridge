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
  declare name: CreationOptional<string | null>;
  declare parentId: CreationOptional<number | null>;

  declare posts?: NonAttribute<Post[]>;
  declare parent?: NonAttribute<Category>;
  declare children?: NonAttribute<Category[]>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: DataTypes.STRING(60),
        parentId: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Category',
        tableName: 'categories',
        timestamps: false,
      }
    );
    return Category;
  }
}
