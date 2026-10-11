'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      slug: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
    },
    { tableName: 'blog_category', underscored: true }
  );

  Category.associate = (models) => {
    Category.belongsTo(models.Category, {
      as: 'parent',
      foreignKey: { name: 'parentId', allowNull: true },
      onDelete: 'SET NULL',
    });
    Category.hasMany(models.Category, {
      as: 'children',
      foreignKey: 'parentId',
    });
  };

  return Category;
};
