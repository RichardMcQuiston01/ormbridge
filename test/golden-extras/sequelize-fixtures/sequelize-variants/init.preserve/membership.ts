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
import type { Group } from './group.js';

export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  declare role: CreationOptional<string | null>;
  declare AccountId: number;
  declare GroupId: number;

  declare account?: NonAttribute<Account>;
  declare group?: NonAttribute<Group>;

  static initModel(sequelize: Sequelize): typeof Membership {
    Membership.init(
      {
        role: { type: DataTypes.STRING(20), defaultValue: 'member' },
        AccountId: { type: DataTypes.INTEGER, primaryKey: true },
        GroupId: { type: DataTypes.INTEGER, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Membership',
        tableName: 'Memberships',
        timestamps: false,
      }
    );
    return Membership;
  }
}
