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
  declare id: CreationOptional<string>;
  declare name: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare countryCode: CreationOptional<string | null>;

  declare country?: NonAttribute<Country>;

  static initModel(sequelize: Sequelize): typeof City {
    City.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        name: DataTypes.STRING(255),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        countryCode: DataTypes.STRING(2),
      },
      {
        sequelize,
        modelName: 'City',
        tableName: 'city',
        timestamps: true,
        underscored: true,
      }
    );
    return City;
  }
}
