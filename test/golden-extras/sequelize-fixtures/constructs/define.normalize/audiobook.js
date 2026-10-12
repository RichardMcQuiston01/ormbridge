'use strict';

module.exports = (sequelize, DataTypes) => {
  const Audiobook = sequelize.define(
    'Audiobook',
    {
      minutes: { type: DataTypes.INTEGER, allowNull: false },
      bookPtrId: { type: DataTypes.UUID, primaryKey: true },
    },
    { tableName: 'audiobook', timestamps: true, underscored: true }
  );

  Audiobook.associate = (models) => {
    Audiobook.belongsTo(models.Book, {
      as: 'book',
      foreignKey: 'bookPtrId',
      onDelete: 'CASCADE',
    });
  };

  return Audiobook;
};
