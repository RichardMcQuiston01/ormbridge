'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: DataTypes.STRING(60),
      parentId: DataTypes.UUID,
    },
    { tableName: 'category', timestamps: true, underscored: true }
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
