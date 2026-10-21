'use strict';

// A table name kept in a constant, DataTypes taken from the Sequelize argument, and the migration written
// with `exports.up`.
const ACCOUNTS = 'accounts';

exports.up = async (queryInterface, Sequelize) => {
  const { DataTypes } = Sequelize;
  await queryInterface.createTable(ACCOUNTS, {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
    },
    handle: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    balance: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    ratio: { type: DataTypes.FLOAT, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    settings: { type: DataTypes.JSON },
    avatar: DataTypes.BLOB,
    born: DataTypes.DATEONLY,
    opened_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  });
};

exports.down = (queryInterface) => queryInterface.dropTable(ACCOUNTS);
