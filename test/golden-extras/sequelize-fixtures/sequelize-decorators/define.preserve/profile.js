'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      authorId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    },
    { tableName: 'profiles', timestamps: false }
  );

  Profile.associate = (models) => {
    Profile.belongsTo(models.Author, {
      as: 'author',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
  };

  return Profile;
};
