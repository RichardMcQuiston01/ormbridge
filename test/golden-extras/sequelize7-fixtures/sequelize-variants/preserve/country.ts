import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'countries', timestamps: false })
export class Country extends Model<
  InferAttributes<Country>,
  InferCreationAttributes<Country>
> {
  @Attribute(DataTypes.STRING(2))
  @PrimaryKey
  declare code: string;

  @Attribute(DataTypes.STRING(255))
  declare name: CreationOptional<string | null>;
}
