'use strict';

module.exports = (sequelize, DataTypes) => {
  const Ticket = sequelize.define(
    'Ticket',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      seat: DataTypes.STRING(10),
      eventId: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'tickets', timestamps: false }
  );

  Ticket.associate = (models) => {
    Ticket.belongsTo(models.Event, {
      as: 'event',
      foreignKey: 'eventId',
      onDelete: 'CASCADE',
    });
  };

  return Ticket;
};
