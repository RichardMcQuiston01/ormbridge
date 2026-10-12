'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      bio: DataTypes.TEXT,
      owner_account_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
      },
    },
    { tableName: 'profiles', timestamps: false }
  );

  Profile.associate = (models) => {
    Profile.belongsTo(models.Account, {
      as: 'owner',
      foreignKey: 'owner_account_id',
      onDelete: 'CASCADE',
    });
  };

  return Profile;
};
