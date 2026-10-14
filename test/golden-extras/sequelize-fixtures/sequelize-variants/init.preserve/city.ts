import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Country } from './country.js';

export class City extends Model<
  InferAttributes<City>,
  InferCreationAttributes<City>
> {
  declare id: CreationOptional<number>;
  declare name: CreationOptional<string | null>;
  declare countryCode: CreationOptional<string | null>;

  declare country?: NonAttribute<Country>;

  static initModel(sequelize: Sequelize): typeof City {
    City.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: DataTypes.STRING(255),
        countryCode: DataTypes.STRING(2),
      },
      { sequelize, modelName: 'City', tableName: 'cities', timestamps: false }
    );
    return City;
  }
}
