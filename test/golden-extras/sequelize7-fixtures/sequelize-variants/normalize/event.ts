import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'event',
  timestamps: true,
  underscored: true,
  indexes: [
    { name: 'events_title', fields: ['title'] },
    { fields: [{ name: 'starts_at', order: 'DESC' }, 'capacity'] },
    { unique: true, fields: ['title', 'starts_at'] },
  ],
})
export class Event extends Model<
  InferAttributes<Event>,
  InferCreationAttributes<Event>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(80))
  declare title: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  @NotNull
  declare startsAt: Date;

  @Attribute(DataTypes.INTEGER)
  declare capacity: CreationOptional<number | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
