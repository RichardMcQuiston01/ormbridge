'use strict';

module.exports = (sequelize, DataTypes) => {
  const Audiobook = sequelize.define(
    'Audiobook',
    {
      minutes: { type: DataTypes.INTEGER, allowNull: false },
      book_ptr_id: { type: DataTypes.BIGINT, primaryKey: true },
    },
    { tableName: 'audiobooks', timestamps: false }
  );

  Audiobook.associate = (models) => {
    Audiobook.belongsTo(models.Book, {
      as: 'book',
      foreignKey: 'book_ptr_id',
      onDelete: 'CASCADE',
    });
  };

  return Audiobook;
};
