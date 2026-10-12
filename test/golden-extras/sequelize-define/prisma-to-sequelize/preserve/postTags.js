'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTags = sequelize.define(
    'PostTags',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      post_id: { type: DataTypes.INTEGER, allowNull: false },
      tag_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      tableName: 'blog_post_tags',
      timestamps: false,
      indexes: [
        { unique: true, fields: ['post_id', 'tag_id'] },
      ],
    }
  );

  PostTags.associate = (models) => {
    PostTags.belongsTo(models.Post, {
      as: 'post',
      foreignKey: 'post_id',
      onDelete: 'CASCADE',
    });
    PostTags.belongsTo(models.Tag, {
      as: 'tag',
      foreignKey: 'tag_id',
      onDelete: 'CASCADE',
    });
  };

  return PostTags;
};
