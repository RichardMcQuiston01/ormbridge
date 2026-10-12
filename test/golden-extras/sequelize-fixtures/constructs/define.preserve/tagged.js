'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tagged = sequelize.define(
    'Tagged',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    },
    { tableName: 'tagged', timestamps: false }
  );

  Tagged.associate = (models) => {
    Tagged.belongsToMany(models.Book, {
      as: 'books',
      through: 'tagged_books',
      foreignKey: 'tagged_id',
      otherKey: 'book_id',
      timestamps: false,
    });
  };

  return Tagged;
};
