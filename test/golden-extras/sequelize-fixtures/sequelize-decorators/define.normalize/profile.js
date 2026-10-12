'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      authorId: { type: DataTypes.UUID, allowNull: false, unique: true },
    },
    { tableName: 'profile', timestamps: true, underscored: true }
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
