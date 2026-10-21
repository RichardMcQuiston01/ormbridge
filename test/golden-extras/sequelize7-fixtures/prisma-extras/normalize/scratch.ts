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
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'scratch',
  schema: 'audit',
  timestamps: true,
  underscored: true,
})
export class Scratch extends Model<
  InferAttributes<Scratch>,
  InferCreationAttributes<Scratch>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare id: number;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
