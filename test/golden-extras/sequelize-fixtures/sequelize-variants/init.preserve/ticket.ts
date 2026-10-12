import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Event } from './event.js';

export class Ticket extends Model<
  InferAttributes<Ticket>,
  InferCreationAttributes<Ticket>
> {
  declare id: CreationOptional<number>;
  declare seat: CreationOptional<string | null>;
  declare eventId: number;

  declare event?: NonAttribute<Event>;

  static initModel(sequelize: Sequelize): typeof Ticket {
    Ticket.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        seat: DataTypes.STRING(10),
        eventId: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Ticket',
        tableName: 'tickets',
        timestamps: false,
      }
    );
    return Ticket;
  }
}
