'use strict';

module.exports = (sequelize, DataTypes) => {
  const Customer = sequelize.define(
    'Customer',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      deletedAt: DataTypes.DATE,
      email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      name: DataTypes.STRING(100),
      role: {
        type: DataTypes.ENUM('customer', 'staff', 'admin'),
        allowNull: false,
        defaultValue: 'customer',
      },
      billingStreet: { type: DataTypes.STRING(120), allowNull: false },
      billingCity: { type: DataTypes.STRING(60), allowNull: false },
      billingPostal: { type: DataTypes.STRING(12), field: 'billing_zip' },
      shippingStreet: { type: DataTypes.STRING(120), allowNull: false },
      shippingCity: { type: DataTypes.STRING(60), allowNull: false },
      shippingPostal: { type: DataTypes.STRING(12), field: 'shipping_zip' },
      balance: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      rank: { type: DataTypes.BIGINT, allowNull: false },
      avatar: { type: DataTypes.BLOB, allowNull: false },
      settings: { type: DataTypes.JSONB, allowNull: false },
    },
    {
      tableName: 'customer',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['deleted_at'] },
      ],
    }
  );

  Customer.associate = (models) => {
    Customer.hasMany(models.Order, {
      as: 'orders',
      foreignKey: 'customerId',
      onDelete: 'RESTRICT',
    });
  };

  return Customer;
};
