'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      label: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
    },
    { tableName: 'blog_tag', timestamps: false }
  );

  Tag.associate = (models) => {
    Tag.belongsToMany(models.Post, {
      through: 'blog_post_tags',
      as: 'posts',
      foreignKey: 'tag_id',
      otherKey: 'post_id',
      timestamps: false,
    });
  };

  return Tag;
};
