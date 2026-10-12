import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

export class Product extends Model<
  InferAttributes<Product>,
  InferCreationAttributes<Product>
> {
  declare sku: string;
  declare title: string;
  declare slug: string;
  declare price: string;
  declare stock: CreationOptional<number>;
  declare deletedAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare similar?: NonAttribute<Product[]>;

  static initModel(sequelize: Sequelize): typeof Product {
    Product.init(
      {
        sku: { type: DataTypes.STRING(40), primaryKey: true },
        title: { type: DataTypes.STRING(200), allowNull: false },
        slug: { type: DataTypes.STRING(100), allowNull: false },
        price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
        stock: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
          field: 'in_stock',
        },
        deletedAt: DataTypes.DATE,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Product',
        tableName: 'product',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['title'] },
          { name: 'idx_product_slug', using: 'HASH', fields: ['slug'] },
        ],
      }
    );
    return Product;
  }
}
