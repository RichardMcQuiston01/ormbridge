'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogCategory = sequelize.define(
    'BlogCategory',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      slug: { type: DataTypes.STRING(50), allowNull: false },
      parent_id: DataTypes.INTEGER,
    },
    {
      tableName: 'blog_category',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  BlogCategory.associate = (models) => {
    BlogCategory.belongsTo(models.BlogCategory, {
      as: 'parent',
      foreignKey: 'parent_id',
      onDelete: 'SET NULL',
    });
    BlogCategory.hasMany(models.BlogCategory, {
      as: 'blog_categories',
      foreignKey: 'parent_id',
      onDelete: 'SET NULL',
    });
    BlogCategory.hasMany(models.BlogPost, {
      as: 'blog_posts',
      foreignKey: 'category_id',
      onDelete: 'RESTRICT',
    });
  };

  return BlogCategory;
};
