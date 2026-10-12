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
      bio: DataTypes.TEXT,
      ownerAccountId: { type: DataTypes.UUID, allowNull: false, unique: true },
    },
    { tableName: 'profile', timestamps: true, underscored: true }
  );

  Profile.associate = (models) => {
    Profile.belongsTo(models.Account, {
      as: 'owner',
      foreignKey: 'ownerAccountId',
      onDelete: 'CASCADE',
    });
  };

  return Profile;
};
