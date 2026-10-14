'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tagged = sequelize.define(
    'Tagged',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
    },
    { tableName: 'tagged', timestamps: true, underscored: true }
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
