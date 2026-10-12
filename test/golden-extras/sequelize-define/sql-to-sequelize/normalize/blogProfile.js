'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogProfile = sequelize.define(
    'BlogProfile',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      bio: DataTypes.TEXT,
      avatar: DataTypes.STRING(100),
      userId: { type: DataTypes.UUID, allowNull: false, unique: true },
    },
    { tableName: 'blog_profile', timestamps: true, underscored: true }
  );

  BlogProfile.associate = (models) => {
    BlogProfile.belongsTo(models.BlogUser, {
      as: 'user',
      foreignKey: 'userId',
      onDelete: 'CASCADE',
    });
  };

  return BlogProfile;
};
