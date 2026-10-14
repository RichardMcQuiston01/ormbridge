'use strict';

module.exports = (sequelize, DataTypes) => {
  const Other = sequelize.define(
    'Other',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
    },
    { tableName: 'other', timestamps: true, underscored: true }
  );

  Other.associate = (models) => {
    Other.hasMany(models.Weird, {
      as: 'weirds',
      foreignKey: 'otherId',
      onDelete: 'CASCADE',
    });
  };

  return Other;
};
