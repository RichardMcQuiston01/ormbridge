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
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Country {
    Country.init(
      {
        code: { type: DataTypes.STRING(2), primaryKey: true },
        name: DataTypes.STRING(255),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Country',
        tableName: 'country',
        timestamps: true,
        underscored: true,
      }
    );
    return Country;
  }
}
