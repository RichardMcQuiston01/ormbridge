'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogProfile = sequelize.define(
    'BlogProfile',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      bio: DataTypes.TEXT,
      avatar: DataTypes.STRING(100),
      user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    },
    { tableName: 'blog_profile', timestamps: false }
  );

  BlogProfile.associate = (models) => {
    BlogProfile.belongsTo(models.BlogUser, {
      as: 'user',
      foreignKey: 'user_id',
      onDelete: 'CASCADE',
    });
  };

  return BlogProfile;
};
