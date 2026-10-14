'use strict';

module.exports = (sequelize, DataTypes) => {
  const Counter = sequelize.define(
    'Counter',
    {
      small_id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      label: { type: DataTypes.STRING(20), allowNull: false },
    },
    { tableName: 'blog_counter', timestamps: false }
  );

  return Counter;
};
