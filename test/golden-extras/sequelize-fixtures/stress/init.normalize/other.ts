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
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare weirds?: NonAttribute<Weird[]>;

  static initModel(sequelize: Sequelize): typeof Other {
    Other.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Other',
        tableName: 'other',
        timestamps: true,
        underscored: true,
      }
    );
    return Other;
  }
}
