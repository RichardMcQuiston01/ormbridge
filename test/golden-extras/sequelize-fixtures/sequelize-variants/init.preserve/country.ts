import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Country extends Model<
  InferAttributes<Country>,
  InferCreationAttributes<Country>
> {
  declare code: string;
  declare name: CreationOptional<string | null>;

  static initModel(sequelize: Sequelize): typeof Country {
    Country.init(
      {
        code: { type: DataTypes.STRING(2), primaryKey: true },
        name: DataTypes.STRING(255),
      },
      {
        sequelize,
        modelName: 'Country',
        tableName: 'countries',
        timestamps: false,
      }
    );
    return Country;
  }
}
