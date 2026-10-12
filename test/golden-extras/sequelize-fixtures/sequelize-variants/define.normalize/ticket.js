'use strict';

module.exports = (sequelize, DataTypes) => {
  const Ticket = sequelize.define(
    'Ticket',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      seat: DataTypes.STRING(10),
      eventId: { type: DataTypes.UUID, allowNull: false },
    },
    { tableName: 'ticket', timestamps: true, underscored: true }
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
