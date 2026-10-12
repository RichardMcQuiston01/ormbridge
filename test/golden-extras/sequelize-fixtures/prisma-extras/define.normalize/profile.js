'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      region: { type: DataTypes.STRING, primaryKey: true },
      number: { type: DataTypes.INTEGER, primaryKey: true },
      accountId: { type: DataTypes.UUID, allowNull: false, unique: true },
    },
    {
      tableName: 'profile',
      schema: 'public',
      timestamps: true,
      underscored: true,
    }
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
