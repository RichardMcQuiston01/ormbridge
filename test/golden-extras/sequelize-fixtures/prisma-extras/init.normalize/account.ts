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
  declare id: CreationOptional<string>;
  declare email: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare tenantId: string;

  declare tenant?: NonAttribute<Tenant>;
  declare profile?: NonAttribute<Profile>;

  static initModel(sequelize: Sequelize): typeof Account {
    Account.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        email: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: 'uq_account_email',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        tenantId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Account',
        tableName: 'account',
        schema: 'public',
        timestamps: true,
        underscored: true,
      }
    );
    return Account;
  }
}
