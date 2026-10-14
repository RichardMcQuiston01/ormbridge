import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Account } from './account.js';
import type { Group } from './group.js';

export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  declare role: 'owner' | 'member';
  declare account_id: string;
  declare group_id: number;

  declare account?: NonAttribute<Account>;
  declare group?: NonAttribute<Group>;

  static initModel(sequelize: Sequelize): typeof Membership {
    Membership.init(
      {
        role: { type: DataTypes.ENUM('owner', 'member'), allowNull: false },
        account_id: { type: DataTypes.BIGINT, primaryKey: true },
        group_id: { type: DataTypes.INTEGER, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Membership',
        tableName: 'memberships',
        timestamps: false,
      }
    );
    return Membership;
  }
}
