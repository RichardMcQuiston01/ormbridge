import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Profile } from './profile.js';
import type { Tenant } from './tenant.js';

export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  declare id: CreationOptional<number>;
  declare email: string;
  declare tenantId: number;

  declare tenant?: NonAttribute<Tenant>;
  declare profile?: NonAttribute<Profile>;

  static initModel(sequelize: Sequelize): typeof Account {
    Account.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: 'uq_account_email',
        },
        tenantId: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Account',
        tableName: 'Account',
        schema: 'public',
        timestamps: false,
      }
    );
    return Account;
  }
}
