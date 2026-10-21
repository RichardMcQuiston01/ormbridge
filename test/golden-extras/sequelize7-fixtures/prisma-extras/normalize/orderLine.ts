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
  tableName: 'order_line',
  schema: 'public',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['order_region', 'order_number'] },
  ],
})
export class OrderLine extends Model<
  InferAttributes<OrderLine>,
  InferCreationAttributes<OrderLine>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING)
  @NotNull
  declare orderRegion: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare orderNumber: number;

  @Attribute(DataTypes.STRING(32))
  @NotNull
  declare sku: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
