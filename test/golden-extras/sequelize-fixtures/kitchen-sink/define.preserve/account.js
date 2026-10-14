'use strict';

module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define(
    'Account',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      deleted_at: DataTypes.DATE,
      email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      balance: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      score: DataTypes.DOUBLE,
      avatar: DataTypes.BLOB,
      payload: DataTypes.JSON,
      labels: { type: DataTypes.JSON, allowNull: false },
      ttl: DataTypes.BIGINT,
      ip: DataTypes.STRING(45),
      homepage_url: DataTypes.TEXT,
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
      tableName: 'accounts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['deleted_at'] },
        { fields: ['email', 'status'] },
      ],
    }
  );

  Account.associate = (models) => {
    Account.hasMany(models.Session, {
      as: 'sessions',
      foreignKey: 'account_id',
      onDelete: 'SET NULL',
    });
    Account.hasOne(models.Profile, {
      as: 'profile',
      foreignKey: 'owner_account_id',
      onDelete: 'CASCADE',
    });
  };

  return Account;
};
