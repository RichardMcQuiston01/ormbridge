'use strict';

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        field: 'Id',
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
        field: 'Name',
      },
      slug: { type: DataTypes.STRING(50), allowNull: false, field: 'Slug' },
      parent_id: DataTypes.INTEGER,
    },
    { tableName: 'blog_category', timestamps: true, underscored: true }
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
  };

  return Category;
};
