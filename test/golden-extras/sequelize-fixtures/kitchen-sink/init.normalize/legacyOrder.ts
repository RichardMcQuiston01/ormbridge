import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Account } from './account.js';

export class LegacyOrder extends Model<
  InferAttributes<LegacyOrder>,
  InferCreationAttributes<LegacyOrder>
> {
  declare orderNo: number;
  declare type: string;
  declare httpCode: number;
  declare firstName: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare acct: CreationOptional<string | null>;

  declare owner?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof LegacyOrder {
    LegacyOrder.init(
      {
        orderNo: { type: DataTypes.INTEGER, primaryKey: true },
        type: { type: DataTypes.TEXT, allowNull: false, field: 'kind' },
        httpCode: { type: DataTypes.INTEGER, allowNull: false },
        firstName: DataTypes.TEXT,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        acct: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'LegacyOrder',
        tableName: 'legacy_order',
        timestamps: true,
        underscored: true,
      }
    );
    return LegacyOrder;
  }
}
