'use strict';

module.exports = (sequelize, DataTypes) => {
  const Session = sequelize.define(
    'Session',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      token: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4 },
      deletedAt: DataTypes.DATE,
      openedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      accountId: DataTypes.UUID,
    },
    {
      tableName: 'session',
      timestamps: true,
      underscored: true,
      indexes: [
        { unique: true, fields: ['account_id', 'opened_at'] },
      ],
    }
  );

  Session.associate = (models) => {
    Session.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'accountId',
      onDelete: 'SET NULL',
    });
  };

  return Session;
};
