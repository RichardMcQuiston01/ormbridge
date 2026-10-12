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
      deleted_at: DataTypes.DATE,
      opened_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      account_id: DataTypes.BIGINT,
    },
    {
      tableName: 'sessions',
      timestamps: false,
      indexes: [
        { unique: true, fields: ['account_id', 'opened_at'] },
      ],
    }
  );

  Session.associate = (models) => {
    Session.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'account_id',
      onDelete: 'SET NULL',
    });
  };

  return Session;
};
