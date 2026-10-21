import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'events',
  timestamps: false,
  indexes: [
    { name: 'events_title', fields: ['title'] },
    { fields: [{ name: 'startsAt', order: 'DESC' }, 'capacity'] },
    { unique: true, fields: ['title', 'startsAt'] },
  ],
})
export class Event extends Model<
  InferAttributes<Event>,
  InferCreationAttributes<Event>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(80))
  declare title: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  @NotNull
  declare startsAt: Date;

  @Attribute(DataTypes.INTEGER)
  declare capacity: CreationOptional<number | null>;
}
