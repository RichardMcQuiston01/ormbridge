'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTags = sequelize.define(
    'PostTags',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      postId: { type: DataTypes.UUID, allowNull: false },
      tagId: { type: DataTypes.UUID, allowNull: false },
    },
    {
      tableName: 'post_tag',
      timestamps: true,
      underscored: true,
      indexes: [
        { unique: true, fields: ['post_id', 'tag_id'] },
      ],
    }
  );

  PostTags.associate = (models) => {
    PostTags.belongsTo(models.Post, {
      as: 'post',
      foreignKey: 'postId',
      onDelete: 'CASCADE',
    });
    PostTags.belongsTo(models.Tag, {
      as: 'tag',
      foreignKey: 'tagId',
      onDelete: 'CASCADE',
    });
  };

  return PostTags;
};
