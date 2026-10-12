'use strict';

module.exports = (sequelize, DataTypes) => {
  const Event = sequelize.define(
    'Event',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      title: DataTypes.STRING(80),
      startsAt: { type: DataTypes.DATE, allowNull: false },
      capacity: DataTypes.INTEGER,
    },
    {
      tableName: 'event',
      timestamps: true,
      underscored: true,
      indexes: [
        { name: 'events_title', fields: ['title'] },
        { fields: [{ name: 'starts_at', order: 'DESC' }, 'capacity'] },
        { unique: true, fields: ['title', 'starts_at'] },
      ],
    }
  );

  return Event;
};
