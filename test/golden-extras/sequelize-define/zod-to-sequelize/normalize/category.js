'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      slug: { type: DataTypes.STRING(50), allowNull: false },
      parentId: DataTypes.INTEGER,
    },
    {
      tableName: 'category',
      timestamps: true,
      updatedAt: false,
      underscored: true,
    }
  );

  return Category;
};
