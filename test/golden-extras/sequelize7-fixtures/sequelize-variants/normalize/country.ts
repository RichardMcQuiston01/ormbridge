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

@Table({ tableName: 'country', timestamps: true, underscored: true })
export class Country extends Model<
  InferAttributes<Country>,
  InferCreationAttributes<Country>
> {
  @Attribute(DataTypes.STRING(2))
  @PrimaryKey
  declare code: string;

  @Attribute(DataTypes.STRING(255))
  declare name: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
