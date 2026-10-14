'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      slug: { type: DataTypes.STRING(50), allowNull: false },
      parent_id: DataTypes.INTEGER,
    },
    {
      tableName: 'blog_category',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  Category.associate = (models) => {
    Category.belongsTo(models.Category, {
      as: 'parent',
      foreignKey: 'parent_id',
      onDelete: 'SET NULL',
    });
    Category.hasMany(models.Category, {
      as: 'children',
      foreignKey: 'parent_id',
      onDelete: 'SET NULL',
    });
    Category.hasMany(models.Post, {
      as: 'post_set',
      foreignKey: 'category_id',
      onDelete: 'RESTRICT',
    });
  };

  return Category;
};
