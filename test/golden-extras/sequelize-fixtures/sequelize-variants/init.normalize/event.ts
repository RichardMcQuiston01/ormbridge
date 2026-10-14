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
  declare id: CreationOptional<string>;
  declare title: CreationOptional<string | null>;
  declare startsAt: Date;
  declare capacity: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Event {
    Event.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        title: DataTypes.STRING(80),
        startsAt: { type: DataTypes.DATE, allowNull: false },
        capacity: DataTypes.INTEGER,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Event',
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
  }
}
