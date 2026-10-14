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
  declare order_no: number;
  declare type: string;
  declare HTTPCode: number;
  declare first_name: CreationOptional<string | null>;
  declare acct: CreationOptional<string | null>;

  declare owner?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof LegacyOrder {
    LegacyOrder.init(
      {
        order_no: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          field: 'OrderNo',
        },
        type: { type: DataTypes.TEXT, allowNull: false, field: 'kind' },
        HTTPCode: {
          type: DataTypes.INTEGER,
          allowNull: false,
          field: 'http_code',
        },
        first_name: { type: DataTypes.TEXT, field: 'first name' },
        acct: DataTypes.BIGINT,
      },
      {
        sequelize,
        modelName: 'LegacyOrder',
        tableName: 'LEGACY_ORDER',
        timestamps: false,
      }
    );
    return LegacyOrder;
  }
}
