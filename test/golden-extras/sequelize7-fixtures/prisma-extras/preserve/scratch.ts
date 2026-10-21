import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'Scratch', schema: 'audit', timestamps: false })
export class Scratch extends Model<
  InferAttributes<Scratch>,
  InferCreationAttributes<Scratch>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare id: number;
}
