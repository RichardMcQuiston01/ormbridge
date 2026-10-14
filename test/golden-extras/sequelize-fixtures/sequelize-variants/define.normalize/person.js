'use strict';

module.exports = (sequelize, DataTypes) => {
  const Person = sequelize.define(
    'Person',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: { type: DataTypes.STRING(255), allowNull: false },
      born: DataTypes.DATEONLY,
      wakeUp: DataTypes.TIME,
      photo: DataTypes.BLOB,
      height: DataTypes.DOUBLE,
      rank: DataTypes.BIGINT,
      shelf: DataTypes.INTEGER,
      deletedAt: DataTypes.DATE,
    },
    { tableName: 'person', timestamps: true, underscored: true }
  );

  Person.associate = (models) => {
    Person.belongsToMany(models.Person, {
      as: 'friends',
      through: 'person_friends',
      foreignKey: 'from_person_id',
      otherKey: 'to_person_id',
      timestamps: false,
    });
  };

  return Person;
};
