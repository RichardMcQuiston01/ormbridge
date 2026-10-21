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
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import type { Weird } from './weird.js';

@Table({ tableName: 'others', timestamps: false })
export class Other extends Model<
  InferAttributes<Other>,
  InferCreationAttributes<Other>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  declare weirds?: NonAttribute<Weird[]>;
}
