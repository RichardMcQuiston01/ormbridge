import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare id: CreationOptional<number>;
  declare name: string;
  declare slug: string;
  declare parent_id: CreationOptional<number | null>;

  declare parent?: NonAttribute<Category>;
  declare children?: NonAttribute<Category[]>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
      {
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          field: 'Id',
        },
        name: {
          type: DataTypes.STRING(100),
          allowNull: false,
          unique: true,
          field: 'Name',
        },
        slug: { type: DataTypes.STRING(50), allowNull: false, field: 'Slug' },
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
