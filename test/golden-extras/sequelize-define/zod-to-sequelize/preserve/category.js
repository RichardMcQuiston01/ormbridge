'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      slug: { type: DataTypes.STRING(50), allowNull: false },
      parent_id: DataTypes.INTEGER,
    },
    {
      tableName: 'Category',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return Category;
};
