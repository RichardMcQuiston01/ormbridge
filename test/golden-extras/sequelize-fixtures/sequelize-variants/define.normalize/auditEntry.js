'use strict';

module.exports = (sequelize, DataTypes) => {
  const AuditEntry = sequelize.define(
    'AuditEntry',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      action: { type: DataTypes.STRING(255), allowNull: false },
      level: { type: DataTypes.ENUM('info', 'warn'), defaultValue: 'info' },
      loggedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'audit_entry', timestamps: true, underscored: true }
  );

  return AuditEntry;
};
