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
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare name: string;
  declare slug: string;
  declare parentId: CreationOptional<string | null>;

  declare parent?: NonAttribute<Category>;
  declare children?: NonAttribute<Category[]>;
  declare postSet?: NonAttribute<Post[]>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
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
        modelName: 'Category',
        tableName: 'category',
        timestamps: true,
        underscored: true,
      }
    );
    return Category;
  }
}
