'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: DataTypes.STRING(60),
      parentId: DataTypes.INTEGER,
    },
    { tableName: 'categories', timestamps: false }
  );

  Category.associate = (models) => {
    Category.hasMany(models.Post, {
      as: 'posts',
      foreignKey: 'categoryId',
      onDelete: 'SET NULL',
    });
    Category.belongsTo(models.Category, {
      as: 'parent',
      foreignKey: 'parentId',
      onDelete: 'SET NULL',
    });
    Category.hasMany(models.Category, {
      as: 'children',
      foreignKey: 'parentId',
      onDelete: 'SET NULL',
    });
  };

  return Category;
};
