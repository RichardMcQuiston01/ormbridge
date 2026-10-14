'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      region: { type: DataTypes.STRING, primaryKey: true },
      number: { type: DataTypes.INTEGER, primaryKey: true },
      accountId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    },
    { tableName: 'Profile', schema: 'public', timestamps: false }
  );

  Profile.associate = (models) => {
    Profile.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'accountId',
      onDelete: 'RESTRICT',
    });
  };

  return Profile;
};
