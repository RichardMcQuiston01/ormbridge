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
  tableName: 'OrderLine',
  schema: 'public',
  timestamps: false,
  indexes: [
    { fields: ['orderRegion', 'orderNumber'] },
  ],
})
export class OrderLine extends Model<
  InferAttributes<OrderLine>,
  InferCreationAttributes<OrderLine>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING)
  @NotNull
  declare orderRegion: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare orderNumber: number;

  @Attribute(DataTypes.STRING(32))
  @NotNull
  declare sku: string;
}
