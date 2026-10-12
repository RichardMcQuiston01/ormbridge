'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogCategory = sequelize.define(
    'BlogCategory',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      slug: { type: DataTypes.STRING(50), allowNull: false },
      parentId: DataTypes.UUID,
    },
    {
      tableName: 'blog_category',
      timestamps: true,
      updatedAt: false,
      underscored: true,
    }
  );

  BlogCategory.associate = (models) => {
    BlogCategory.belongsTo(models.BlogCategory, {
      as: 'parent',
      foreignKey: 'parentId',
      onDelete: 'SET NULL',
    });
    BlogCategory.hasMany(models.BlogCategory, {
      as: 'blogCategories',
      foreignKey: 'parentId',
      onDelete: 'SET NULL',
    });
    BlogCategory.hasMany(models.BlogPost, {
      as: 'blogPosts',
      foreignKey: 'categoryId',
      onDelete: 'RESTRICT',
    });
  };

  return BlogCategory;
};
