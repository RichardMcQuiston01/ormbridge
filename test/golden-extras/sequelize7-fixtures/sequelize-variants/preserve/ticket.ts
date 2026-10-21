import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  BelongsTo,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Event } from './event.js';

@Table({ tableName: 'tickets', timestamps: false })
export class Ticket extends Model<
  InferAttributes<Ticket>,
  InferCreationAttributes<Ticket>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(10))
  declare seat: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare eventId: number;

  @BelongsTo(() => Event, {
    foreignKey: { name: 'eventId', onDelete: 'CASCADE' },
  })
  declare event?: NonAttribute<Event>;
}
