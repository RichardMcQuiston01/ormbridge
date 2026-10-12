'use strict';

module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define(
    'Product',
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
    },
    {
      tableName: 'product',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['title'] },
        { name: 'idx_product_slug', using: 'HASH', fields: ['slug'] },
      ],
    }
  );

  Product.associate = (models) => {
    Product.belongsToMany(models.Product, {
      as: 'similar',
      through: 'product_similar',
      foreignKey: 'from_product_id',
      otherKey: 'to_product_id',
      timestamps: false,
    });
  };

  return Product;
};
