'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      label: { type: DataTypes.STRING(50), allowNull: false },
    },
    { tableName: 'blog_tag', timestamps: false }
  );

  Tag.associate = (models) => {
    Tag.hasMany(models.PostTag, {
      as: 'posts',
      foreignKey: 'tag_id',
      onDelete: 'CASCADE',
    });
  };

  return Tag;
};
