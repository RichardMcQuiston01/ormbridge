import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Event extends Model<
  InferAttributes<Event>,
  InferCreationAttributes<Event>
> {
  declare id: CreationOptional<number>;
  declare title: CreationOptional<string | null>;
  declare startsAt: Date;
  declare capacity: CreationOptional<number | null>;

  static initModel(sequelize: Sequelize): typeof Event {
    Event.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        title: DataTypes.STRING(80),
        startsAt: { type: DataTypes.DATE, allowNull: false },
        capacity: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Event',
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
  }
}
