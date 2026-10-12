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
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      slug: { type: DataTypes.STRING(50), allowNull: false },
      parentId: DataTypes.UUID,
    },
    { tableName: 'category', timestamps: true, underscored: true }
  );

  Category.associate = (models) => {
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
    Category.hasMany(models.Post, {
      as: 'postSet',
      foreignKey: 'categoryId',
      onDelete: 'RESTRICT',
    });
  };

  return Category;
};
