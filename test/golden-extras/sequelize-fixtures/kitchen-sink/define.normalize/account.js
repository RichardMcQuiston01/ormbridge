'use strict';

module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define(
    'Account',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      deletedAt: DataTypes.DATE,
      email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      balance: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      score: DataTypes.DOUBLE,
      avatar: DataTypes.BLOB,
      payload: DataTypes.JSON,
      labels: { type: DataTypes.JSON, allowNull: false },
      ttl: DataTypes.BIGINT,
      ip: DataTypes.STRING(45),
      homepageUrl: DataTypes.TEXT,
      born: DataTypes.DATEONLY,
      alarm: DataTypes.TIME,
      status: {
        type: DataTypes.ENUM('draft', 'live'),
        allowNull: false,
        defaultValue: 'draft',
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: "it's; fine",
      },
    },
    {
      tableName: 'account',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['deleted_at'] },
        { fields: ['email', 'status'] },
      ],
    }
  );

  Account.associate = (models) => {
    Account.hasMany(models.Session, {
      as: 'sessions',
      foreignKey: 'accountId',
      onDelete: 'SET NULL',
    });
    Account.hasOne(models.Profile, {
      as: 'profile',
      foreignKey: 'ownerAccountId',
      onDelete: 'CASCADE',
    });
  };

  return Account;
};
