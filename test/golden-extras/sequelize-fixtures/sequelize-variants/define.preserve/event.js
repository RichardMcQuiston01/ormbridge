'use strict';

module.exports = (sequelize, DataTypes) => {
  const Event = sequelize.define(
    'Event',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      title: DataTypes.STRING(80),
      startsAt: { type: DataTypes.DATE, allowNull: false },
      capacity: DataTypes.INTEGER,
    },
    {
      tableName: 'events',
      timestamps: false,
      indexes: [
        { name: 'events_title', fields: ['title'] },
        { fields: [{ name: 'startsAt', order: 'DESC' }, 'capacity'] },
        { unique: true, fields: ['title', 'startsAt'] },
      ],
    }
  );

  return Event;
};
