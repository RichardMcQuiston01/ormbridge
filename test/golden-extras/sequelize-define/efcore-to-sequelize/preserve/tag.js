'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        field: 'Id',
      },
      label: { type: DataTypes.STRING(50), allowNull: false, field: 'Label' },
    },
    { tableName: 'blog_tag', timestamps: false }
  );

  Tag.associate = (models) => {
    Tag.belongsToMany(models.Post, {
      as: 'posts',
      through: 'blog_post_tags',
      foreignKey: 'tag_id',
      otherKey: 'post_id',
      timestamps: false,
    });
  };

  return Tag;
};
