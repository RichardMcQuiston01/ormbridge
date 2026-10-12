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
  declare role: 'owner' | 'member';
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare accountId: string;
  declare groupId: string;

  declare account?: NonAttribute<Account>;
  declare group?: NonAttribute<Group>;

  static initModel(sequelize: Sequelize): typeof Membership {
    Membership.init(
      {
        role: { type: DataTypes.ENUM('owner', 'member'), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        accountId: { type: DataTypes.UUID, primaryKey: true },
        groupId: { type: DataTypes.UUID, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Membership',
        tableName: 'membership',
        timestamps: true,
        underscored: true,
      }
    );
    return Membership;
  }
}
