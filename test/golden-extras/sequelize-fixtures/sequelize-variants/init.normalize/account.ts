import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Order } from './order.js';

export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare balance: CreationOptional<string>;
  declare settings: CreationOptional<unknown | null>;
  declare nickname: CreationOptional<string | null>;
  declare legacyCode: CreationOptional<string | null>;
  declare lastSeen: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare orders?: NonAttribute<Order[]>;

  static initModel(sequelize: Sequelize): typeof Account {
    Account.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        email: {
          type: DataTypes.STRING(120),
          allowNull: false,
          unique: 'account_email_unique',
        },
        balance: {
          type: DataTypes.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0,
        },
        settings: { type: DataTypes.JSONB, defaultValue: {} },
        nickname: DataTypes.STRING(255),
        legacyCode: DataTypes.STRING(8),
        lastSeen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Account',
        tableName: 'account',
        timestamps: true,
        underscored: true,
      }
    );
    return Account;
  }
}
