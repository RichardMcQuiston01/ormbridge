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
  declare readonly created_at: CreationOptional<Date>;
  declare updated_at: Date;
  declare name: string;
  declare slug: string;
  declare parent_id: CreationOptional<number | null>;

  static initModel(sequelize: Sequelize): typeof Category {
    Category.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false },
        slug: { type: DataTypes.STRING(50), allowNull: false },
        parent_id: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Category',
        tableName: 'Category',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false,
      }
    );
    return Category;
  }
}
