import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Tenant extends Model<
  InferAttributes<Tenant>,
  InferCreationAttributes<Tenant>
> {
  declare id: CreationOptional<number>;

  static initModel(sequelize: Sequelize): typeof Tenant {
    Tenant.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      },
      {
        sequelize,
        modelName: 'Tenant',
        tableName: 'Tenant',
        schema: 'public',
        timestamps: false,
      }
    );
    return Tenant;
  }
}
