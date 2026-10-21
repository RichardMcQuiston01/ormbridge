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
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Country } from './country.js';

@Table({ tableName: 'cities', timestamps: false })
export class City extends Model<
  InferAttributes<City>,
  InferCreationAttributes<City>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(255))
  declare name: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(2))
  declare countryCode: CreationOptional<string | null>;

  @BelongsTo(() => Country, {
    foreignKey: { name: 'countryCode', onDelete: 'CASCADE' },
  })
  declare country?: NonAttribute<Country>;
}
