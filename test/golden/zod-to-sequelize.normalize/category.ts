import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare id: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare updatedAt: Date;
  declare name: string;
  declare slug: string;
  declare parentId: CreationOptional<number | null>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false },
        slug: { type: DataTypes.STRING(50), allowNull: false },
        parentId: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Category',
        tableName: 'category',
        timestamps: true,
        updatedAt: false,
        underscored: true,
      }
    );
    return Category;
  }
}
