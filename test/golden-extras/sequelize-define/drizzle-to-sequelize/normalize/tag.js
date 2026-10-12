'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      label: { type: DataTypes.STRING(50), allowNull: false },
    },
    { tableName: 'tag', timestamps: true, underscored: true }
  );

  Tag.associate = (models) => {
    Tag.hasMany(models.PostTag, {
      as: 'posts',
      foreignKey: 'tagId',
      onDelete: 'CASCADE',
    });
  };

  return Tag;
};
