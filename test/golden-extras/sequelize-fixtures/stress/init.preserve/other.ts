import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Weird } from './weird.js';

export class Other extends Model<
  InferAttributes<Other>,
  InferCreationAttributes<Other>
> {
  declare id: CreationOptional<number>;

  declare weirds?: NonAttribute<Weird[]>;

  static initModel(sequelize: Sequelize): typeof Other {
    Other.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      },
      { sequelize, modelName: 'Other', tableName: 'others', timestamps: false }
    );
    return Other;
  }
}
