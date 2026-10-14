'use strict';

module.exports = (sequelize, DataTypes) => {
  const AuditEntry = sequelize.define(
    'AuditEntry',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      action: { type: DataTypes.STRING(255), allowNull: false },
      level: { type: DataTypes.ENUM('info', 'warn'), defaultValue: 'info' },
      logged_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'AuditEntry', timestamps: false }
  );

  return AuditEntry;
};
