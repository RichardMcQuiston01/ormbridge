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
  declare id: CreationOptional<string>;
  declare seat: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare eventId: string;

  declare event?: NonAttribute<Event>;

  static initModel(sequelize: Sequelize): typeof Ticket {
    Ticket.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        seat: DataTypes.STRING(10),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        eventId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Ticket',
        tableName: 'ticket',
        timestamps: true,
        underscored: true,
      }
    );
    return Ticket;
  }
}
